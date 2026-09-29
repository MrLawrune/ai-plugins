import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { VoiceScopeState } from "../schemas.ts";
import { rpcStubs, VOICE_SCOPE } from "../page/fixtures.ts";

type Handler = (input: unknown) => unknown;
async function button(overrides: Record<string, Handler> = {}, props = { threadId: "t1", projectId: "p1", isCompactViewport: false }) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const reg = app.threadHeaderActions.find((a) => a.id === "kokoro-voice")!;
  return { reg, slot: renderSlot(reg, props, { rpc: rpcStubs({ getVoiceScope: () => VOICE_SCOPE, ...overrides }) }) };
}
const off = (o: Partial<VoiceScopeState["effective"]>): VoiceScopeState =>
  ({ ...VOICE_SCOPE, effective: { ...VOICE_SCOPE.effective, voiced: false, ...o } });

test("the button names the effective mode and its source", async () => {
  await button();
  expect(await screen.findByRole("button", { name: "Voice: Brief (global)" })).toBeTruthy();
});

test("off states name why", async () => {
  await button({ getVoiceScope: () => ({ ...off({ mode: "quiet", modeFrom: "thread" }), thread: { mode: "quiet" } }) });
  expect(await screen.findByRole("button", { name: "Voice: Off (this thread)" })).toBeTruthy();
});

test("an unvoiced child explains why", async () => {
  await button({ getVoiceScope: () => ({ ...off({ isChild: true }), parentThreadId: "t0" }) });
  expect(await screen.findByRole("button", { name: "Voice: Off (child threads are not voiced)" })).toBeTruthy();
});

test("the override dot shows when the thread or project has a setting", async () => {
  await button({ getVoiceScope: () => ({ ...VOICE_SCOPE, project: { voiceChildren: true } }) });
  expect((await screen.findByRole("button", { name: /^Voice:/ })).querySelector("[data-override]")).toBeTruthy();
});

test("choosing a thread mode calls setVoiceScope", async () => {
  const { slot } = await button();
  fireEvent.click(await screen.findByRole("button", { name: /^Voice:/ }));
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "This thread mode" })).getByRole("radio", { name: /Verbose/ }));
  await waitFor(() => expect(slot.inspection.rpcCalls.find((c) => c.method === "setVoiceScope")?.input)
    .toEqual({ threadId: "t1", projectId: "p1", scope: "thread", patch: { mode: "verbose" } }));
});

test("Default clears the setting and child threads map to booleans", async () => {
  const { slot } = await button({ getVoiceScope: () => ({ ...VOICE_SCOPE, project: { mode: "ambient" } }) });
  fireEvent.click(await screen.findByRole("button", { name: /^Voice:/ }));
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "This project mode" })).getByRole("radio", { name: /^Default/ }));
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "This thread child threads" })).getByRole("radio", { name: "Voice" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.filter((c) => c.method === "setVoiceScope").map((c) => c.input)).toEqual([
    { threadId: "t1", projectId: "p1", scope: "project", patch: { mode: null } },
    { threadId: "t1", projectId: "p1", scope: "thread", patch: { voiceChildren: true } },
  ]));
});

test("each choice group has a visible caption", async () => {
  await button();
  fireEvent.click(await screen.findByRole("button", { name: /^Voice:/ }));
  await screen.findByRole("radiogroup", { name: "This thread child threads" });
  expect(screen.getAllByText("Child threads")).toHaveLength(2);
  expect(screen.getAllByText("Mode")).toHaveLength(2);
});

test("a failed save shows the error and keeps the selection", async () => {
  await button({ setVoiceScope: () => { throw new Error("kv full"); } });
  fireEvent.click(await screen.findByRole("button", { name: /^Voice:/ }));
  const group = await screen.findByRole("radiogroup", { name: "This thread mode" });
  fireEvent.click(within(group).getByRole("radio", { name: /Verbose/ }));
  expect(await screen.findByText(/kv full/)).toBeTruthy();
  expect(within(group).getByRole("radio", { name: /^Default/ }).getAttribute("aria-checked")).toBe("true");
});

test("a failed load still renders a named button", async () => {
  await button({ getVoiceScope: () => { throw new Error("down"); } });
  expect(await screen.findByRole("button", { name: "Voice: unavailable" })).toBeTruthy();
});

test("refetches on kokoro-scopes and kokoro-config", async () => {
  const { slot } = await button();
  await screen.findByRole("button", { name: /^Voice:/ });
  const count = () => slot.inspection.rpcCalls.filter((c) => c.method === "getVoiceScope").length;
  const before = count();
  await slot.emitRealtime("kokoro-scopes", { changed: true });
  await slot.emitRealtime("kokoro-config", {});
  await waitFor(() => expect(count()).toBe(before + 2));
});

test("moving to another thread refetches and ignores a late response", async () => {
  let releaseT1!: () => void;
  const { slot, reg } = await button({ getVoiceScope: (input) => (input as { threadId: string }).threadId === "t1"
    ? new Promise((r) => { releaseT1 = () => r({ ...VOICE_SCOPE, thread: { mode: "full" } }); })
    : { ...VOICE_SCOPE, thread: { mode: "ambient" }, effective: { ...VOICE_SCOPE.effective, mode: "ambient", modeFrom: "thread" } } });
  // rerender takes a React element, not props.
  const Button = reg.component;
  slot.rerender(<Button threadId="t2" projectId="p1" isCompactViewport={false} />);
  expect(await screen.findByRole("button", { name: "Voice: Ambient (this thread)" })).toBeTruthy();
  releaseT1();
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByRole("button", { name: "Voice: Ambient (this thread)" })).toBeTruthy();
});
