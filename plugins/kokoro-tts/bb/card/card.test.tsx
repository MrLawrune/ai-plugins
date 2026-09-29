import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { SpeechLogEntry } from "../schemas.ts";
import { rpcStubs } from "../page/fixtures.ts";
import { normalizeSpoken } from "./match.ts";
import { resetSpeechLogForTests } from "./speech-log.ts";

const MESSAGE = { id: "m1", threadId: "t1", turnId: null, projectId: null };
const SPEECH = { weight: "speech", say: "All tests pass." };
const done = (o: Partial<SpeechLogEntry> = {}): SpeechLogEntry => ({
  id: 3, ts: Date.now() / 1000, session_id: "t1", text: "All tests pass.", status: "done", voice: "af_sky", first_audio_ms: 410, ...o,
});

afterEach(() => vi.useRealTimers());

async function mount(attributes: Record<string, string>, overrides = {}, message = MESSAGE) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const reg = app.messageDirectives.find((d) => d.id === "kokoro-tts")!;
  return renderSlot(reg, { attributes, source: "::kokoro-tts{}", message, openWorkspaceFile: null },
    { rpc: rpcStubs(overrides) });
}

async function card(attributes: Record<string, string>, overrides = {}) {
  resetSpeechLogForTests();
  return mount(attributes, overrides);
}

const speechLogCalls = (slot: Awaited<ReturnType<typeof card>>) =>
  slot.inspection.rpcCalls.filter((c) => c.method === "speechLog").length;

test("a spoken reply shows its text, voice and latency", async () => {
  await card(SPEECH, { speechLog: () => ({ entries: [done()] }) });
  expect(screen.getByText("All tests pass.")).toBeTruthy();
  expect(await screen.findByText("Spoken · af_sky · 410 ms to first audio")).toBeTruthy();
});

test("with no log entry and no turn since mount it shows No record; another thread's entry does not count", async () => {
  await card(SPEECH, { speechLog: () => ({ entries: [done({ session_id: "t2" })] }) });
  expect(await screen.findByText("No record")).toBeTruthy();
});

const turnOut = { threadId: "t1", pending: true };
const turnLogged = (text: string) => ({ threadId: "t1", action: "speech", text });

test("the thread's newest card reads Queued while its turn is out", async () => {
  const slot = await card(SPEECH);
  await screen.findByText("No record");
  await slot.emitRealtime("kokoro-turn", turnOut);
  expect(await screen.findByText("Queued")).toBeTruthy();
});

test("a turn that logged this card's text makes it wait as Queued, then follows the log", async () => {
  let entries: SpeechLogEntry[] = [];
  const slot = await card(SPEECH, { speechLog: () => ({ entries }) });
  await screen.findByText("No record");
  entries = [done({ status: "playing" })];
  await slot.emitRealtime("kokoro-turn", turnLogged("All  tests pass."));
  expect(await screen.findByText("Playing")).toBeTruthy();
});

test("an older card in the thread is not relabelled by a newer reply's turn", async () => {
  const older = await card(SPEECH);
  await screen.findByText("No record");
  const newer = await mount({ weight: "speech", say: "Second reply." });
  await waitFor(() => expect(screen.getAllByText("No record")).toHaveLength(2));
  for (const slot of [older, newer]) await slot.emitRealtime("kokoro-turn", turnOut);
  await waitFor(() => expect(screen.getAllByText("Queued")).toHaveLength(1));
  for (const slot of [older, newer]) await slot.emitRealtime("kokoro-turn", turnLogged("Second reply."));
  await waitFor(() => expect(screen.getAllByText("No record")).toHaveLength(1));
  expect(screen.getAllByText("Queued")).toHaveLength(1);
  expect(older.container.textContent).toContain("No record");
});

test("an off signal marks only the thread's newest card Voice off", async () => {
  const older = await card(SPEECH);
  await screen.findByText("No record");
  const newer = await mount({ weight: "speech", say: "Second reply." });
  await waitFor(() => expect(screen.getAllByText("No record")).toHaveLength(2));
  for (const slot of [older, newer]) await slot.emitRealtime("kokoro-turn", { threadId: "t2", action: "off" });
  expect(screen.getAllByText("No record")).toHaveLength(2);
  for (const slot of [older, newer]) await slot.emitRealtime("kokoro-turn", { threadId: "t1", action: "off" });
  await waitFor(() => expect(newer.container.textContent).toContain("Voice off"));
  expect(older.container.textContent).toContain("No record");
  expect(screen.getAllByText("Voice off")).toHaveLength(1);
});

test("a Voice off card still replays and then follows the log", async () => {
  let entries: SpeechLogEntry[] = [];
  const slot = await card(SPEECH, { speechLog: () => ({ entries }) });
  await screen.findByText("No record");
  await slot.emitRealtime("kokoro-turn", { threadId: "t1", action: "off" });
  await screen.findByText("Voice off");
  entries = [done()];
  fireEvent.click(screen.getByRole("button", { name: "Replay" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "replay")).toBe(true));
  expect(await screen.findByText("Spoken · af_sky · 410 ms to first audio")).toBeTruthy();
});

test("a turn that logged nothing returns the newest card to No record", async () => {
  const slot = await card(SPEECH);
  await slot.emitRealtime("kokoro-turn", turnOut);
  await screen.findByText("Queued");
  await slot.emitRealtime("kokoro-turn", { threadId: "t1", action: "silent" });
  expect(await screen.findByText("No record")).toBeTruthy();
});

test("a reply mute silenced reads Muted right away", async () => {
  const slot = await card(SPEECH);
  await slot.emitRealtime("kokoro-turn", turnOut);
  await screen.findByText("Queued");
  await slot.emitRealtime("kokoro-turn", { threadId: "t1", action: "silent", say: "All tests pass.", muted: true });
  expect(await screen.findByText("Muted")).toBeTruthy();
});

test("a reply the mode or a repeat kept quiet reads Not spoken right away", async () => {
  const slot = await card(SPEECH);
  await screen.findByText("No record");
  await slot.emitRealtime("kokoro-turn", { threadId: "t1", action: "sound", say: "All  tests pass." });
  expect(await screen.findByText("Not spoken")).toBeTruthy();
  expect(slot.container.querySelector(".text-destructive")).toBeNull();
});

test("another reply's say leaves the card alone", async () => {
  const slot = await card(SPEECH);
  await screen.findByText("No record");
  await slot.emitRealtime("kokoro-turn", { threadId: "t1", action: "silent", say: "Something else.", muted: true });
  expect(screen.getByText("No record")).toBeTruthy();
});

test("tab focus refetches only threads that still have a card on the page", async () => {
  const t1 = await card(SPEECH, { speechLog: () => ({ entries: [done()] }) });
  await screen.findByText(/^Spoken/);
  const t2 = await mount(SPEECH, { speechLog: () => ({ entries: [] }) }, { ...MESSAGE, id: "m2", threadId: "t2" });
  await waitFor(() => expect(speechLogCalls(t2)).toBe(1));
  t1.unmount();
  const before = speechLogCalls(t1);
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(speechLogCalls(t2)).toBe(2));
  expect(speechLogCalls(t1)).toBe(before);
  expect(t2.inspection.rpcCalls.filter((c) => c.method === "speechLog").map((c) => c.input)).toEqual([{ threadId: "t2" }, { threadId: "t2" }]);
});

test("a turn in another thread leaves the card at No record", async () => {
  const slot = await card(SPEECH);
  await screen.findByText("No record");
  await slot.emitRealtime("kokoro-turn", { threadId: "t2", pending: true });
  await slot.emitRealtime("kokoro-turn", { threadId: "t2", action: "speech", text: "All tests pass." });
  expect(screen.getByText("No record")).toBeTruthy();
});

test("a turn that never reaches the log reads Not spoken in a neutral tone", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const slot = await card(SPEECH);
  await screen.findByText("No record");
  await slot.emitRealtime("kokoro-turn", turnLogged("All tests pass."));
  await screen.findByText("Queued");
  await act(() => vi.advanceTimersByTimeAsync(26_000));
  expect(await screen.findByText("Not spoken")).toBeTruthy();
  expect(slot.container.querySelector(".text-destructive")).toBeNull();
});

test("while playing, Stop stops this thread's playback", async () => {
  const slot = await card(SPEECH, { speechLog: () => ({ entries: [done({ status: "playing" })] }) });
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.find((c) => c.method === "stop")?.input).toEqual({ threadId: "t1" }));
  expect(slot.inspection.rpcCalls.some((c) => c.method === "interruptAll")).toBe(false);
});

test("the card asks for its own thread's speech log", async () => {
  const slot = await card(SPEECH, { speechLog: () => ({ entries: [done()] }) });
  await screen.findByText(/^Spoken/);
  expect(slot.inspection.rpcCalls.find((c) => c.method === "speechLog")?.input).toEqual({ threadId: "t1" });
});

test("an entry stuck at playing for over 20 minutes reads Interrupted and stops polling", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const slot = await card(SPEECH, { speechLog: () => ({ entries: [done({ status: "playing", ts: Date.now() / 1000 - 21 * 60 })] }) });
  expect(await screen.findByText("Interrupted")).toBeTruthy();
  const before = speechLogCalls(slot);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(speechLogCalls(slot)).toBe(before);
});

test("Replay asks for this reply in this thread", async () => {
  const slot = await card(SPEECH, { speechLog: () => ({ entries: [done()] }) });
  fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.find((c) => c.method === "replay")?.input)
    .toEqual({ threadId: "t1", text: "All tests pass." }));
});

test("Replay sends the normalized, capped text for a long say", async () => {
  const long = "word  ".repeat(500);
  const slot = await card({ weight: "speech", say: long });
  fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "replay")).toBe(true));
  const input = slot.inspection.rpcCalls.find((c) => c.method === "replay")?.input as { text: string };
  expect(input.text).toBe(normalizeSpoken(long));
  expect(input.text.length).toBe(2000);
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

test("a card mounted right after another reuses the fresh speech log", async () => {
  const first = await card(SPEECH, { speechLog: () => ({ entries: [done()] }) });
  await screen.findByText(/^Spoken/);
  const second = await mount({ weight: "speech", say: "All tests pass." }, { speechLog: () => ({ entries: [done()] }) });
  await waitFor(() => expect(screen.getAllByText(/^Spoken/)).toHaveLength(2));
  expect(speechLogCalls(first) + speechLogCalls(second)).toBe(1);
});
