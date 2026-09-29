import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { SpeechLogEntry } from "../schemas.ts";
import { rpcStubs } from "../page/fixtures.ts";
import { resetSpeechLogForTests } from "./speech-log.ts";

const MESSAGE = { id: "m1", threadId: "t1", turnId: null, projectId: null };
const SPEECH = { weight: "speech", say: "All tests pass." };
const done = (o: Partial<SpeechLogEntry> = {}): SpeechLogEntry => ({
  id: 3, ts: 0, session_id: "t1", text: "All tests pass.", status: "done", voice: "af_sky", first_audio_ms: 410, ...o,
});

afterEach(() => vi.useRealTimers());

async function card(attributes: Record<string, string>, overrides = {}, opts: { live?: boolean } = {}) {
  // A live card mounts well after page load; a history card mounts with the page.
  resetSpeechLogForTests({ pageLoadedAt: opts.live ? Date.now() - 60_000 : Date.now() });
  const app = await loadPluginApp(() => import("../app.tsx"));
  const reg = app.messageDirectives.find((d) => d.id === "kokoro-tts")!;
  return renderSlot(reg, { attributes, source: "::kokoro-tts{}", message: MESSAGE, openWorkspaceFile: null },
    { rpc: rpcStubs(overrides) });
}

const speechLogCalls = (slot: Awaited<ReturnType<typeof card>>) =>
  slot.inspection.rpcCalls.filter((c) => c.method === "speechLog").length;

test("a spoken reply shows its text, voice and latency", async () => {
  await card(SPEECH, { speechLog: () => ({ entries: [done()] }) });
  expect(screen.getByText("All tests pass.")).toBeTruthy();
  expect(await screen.findByText("Spoken · af_sky · 410 ms to first audio")).toBeTruthy();
});

test("history with no log entry shows No record; another thread's entry does not count", async () => {
  await card(SPEECH, { speechLog: () => ({ entries: [done({ session_id: "t2" })] }) });
  expect(await screen.findByText("No record")).toBeTruthy();
});

test("a live reply waits as Queued", async () => {
  await card(SPEECH, {}, { live: true });
  expect(await screen.findByText("Queued")).toBeTruthy();
});

test("while playing, Stop stops playback", async () => {
  const slot = await card(SPEECH, { speechLog: () => ({ entries: [done({ status: "playing" })] }) });
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "interruptAll")).toBe(true));
});

test("Replay asks for this reply in this thread", async () => {
  const slot = await card(SPEECH, { speechLog: () => ({ entries: [done()] }) });
  fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.find((c) => c.method === "replay")?.input)
    .toEqual({ threadId: "t1", text: "All tests pass." }));
});

test("Replay with no window explains why nothing played", async () => {
  await card(SPEECH, { speechLog: () => ({ entries: [done()] }), replay: () => ({ status: "no_window" }) });
  fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
  expect(await screen.findByText("No bb window can play right now. Click in a bb window to enable audio.")).toBeTruthy();
});

test("Replay on an older server asks for a restart", async () => {
  await card(SPEECH, { speechLog: () => ({ entries: [done()] }), replay: () => ({ status: "unsupported" }) });
  fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
  expect(await screen.findByText("Restart the Kokoro server to use replay.")).toBeTruthy();
});

test("a sound reply is a one-line chip", async () => {
  await card({ weight: "sound:done" });
  expect(screen.getByText("Done sound")).toBeTruthy();
});

test("a silent reply renders nothing", async () => {
  const slot = await card({ weight: "silent" });
  expect(slot.container.textContent).toBe("");
});

test("a malformed directive stays visible but quiet", async () => {
  await card({ weight: "shout" });
  expect(screen.getByText('kokoro-tts: unknown weight "shout"')).toBeTruthy();
});

test("a speech directive without say is flagged", async () => {
  await card({ weight: "speech" });
  expect(screen.getByText("kokoro-tts: speech with nothing to say")).toBeTruthy();
});

test("a playing card polls until it settles", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let n = 0;
  await card(SPEECH, { speechLog: () => ({ entries: [done({ status: n++ === 0 ? "playing" : "done" })] }) });
  expect(await screen.findByText("Playing")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(2_600));
  expect(await screen.findByText("Spoken · af_sky · 410 ms to first audio")).toBeTruthy();
});

test("a settled card does not keep polling", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const slot = await card(SPEECH, { speechLog: () => ({ entries: [done()] }) });
  await screen.findByText(/^Spoken/);
  const before = speechLogCalls(slot);
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(speechLogCalls(slot)).toBe(before);
});
