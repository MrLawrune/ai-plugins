import { fireEvent, screen, waitFor } from "@testing-library/react";
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

async function open(overrides: Record<string, Handler> = {}) {
  const made = await button(overrides);
  fireEvent.click(await screen.findByRole("button", { name: /^Voice:/ }));
  await screen.findByRole("slider", { name: "This thread mode" });
  return made;
}
const saves = (slot: Awaited<ReturnType<typeof button>>["slot"]) =>
  slot.inspection.rpcCalls.filter((c) => c.method === "setVoiceScope").map((c) => c.input);

test("moving the thread slider saves the mode", async () => {
  const { slot } = await open();
  fireEvent.keyDown(screen.getByRole("slider", { name: "This thread mode" }), { key: "ArrowRight" });
  await waitFor(() => expect(saves(slot))
    .toEqual([{ threadId: "t1", projectId: "p1", scope: "thread", patch: { mode: "conversational" } }]));
});

test("with no setting the slider rests on the default, and says so", async () => {
  await open({ getVoiceScope: () => ({ ...VOICE_SCOPE, project: { mode: "ambient" } }) });
  expect(screen.getByRole("slider", { name: "This thread mode" }).getAttribute("aria-valuetext")).toBe("Brief, default");
  expect(screen.getByRole("slider", { name: "This project mode" }).getAttribute("aria-valuetext")).toBe("Ambient");
});

test("an unvoiced child's slider rests on Off", async () => {
  await open({ getVoiceScope: () => ({ ...off({ isChild: true }), inherited: { ...VOICE_SCOPE.inherited, voiced: false, isChild: true }, parentThreadId: "t0" }) });
  expect(screen.getByRole("slider", { name: "This thread mode" }).getAttribute("aria-valuetext")).toBe("Off (quiet), default");
});

test("Reset clears a setting and shows only where one is set", async () => {
  const { slot } = await open({ getVoiceScope: () => ({ ...VOICE_SCOPE, project: { mode: "ambient" } }) });
  expect(screen.queryByRole("button", { name: "Reset this thread mode" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reset this project mode" }));
  await waitFor(() => expect(saves(slot)).toEqual([{ threadId: "t1", projectId: "p1", scope: "project", patch: { mode: null } }]));
});

test("the child threads dropdown maps to booleans, and Default clears", async () => {
  const { childrenPatch } = await import("./voice-button.tsx");
  expect([childrenPatch("on"), childrenPatch("off"), childrenPatch("default")])
    .toEqual([{ voiceChildren: true }, { voiceChildren: false }, { voiceChildren: null }]);
  await open({ getVoiceScope: () => ({ ...VOICE_SCOPE, project: { voiceChildren: true } }) });
  expect(screen.getByRole("combobox", { name: "This thread child threads" }).textContent).toBe("Default (voice)");
  expect(screen.getByRole("combobox", { name: "This project child threads" }).textContent).toBe("Voice");
});

test("each scope has one slider and one dropdown", async () => {
  await open();
  expect(screen.getAllByRole("slider")).toHaveLength(2);
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.getAllByText("Child threads")).toHaveLength(2);
});

test("a failed save shows the error and the slider returns to the saved mode", async () => {
  await open({ setVoiceScope: () => { throw new Error("kv full"); } });
  const slider = screen.getByRole("slider", { name: "This thread mode" });
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  expect(await screen.findByText(/kv full/)).toBeTruthy();
  await waitFor(() => expect(slider.getAttribute("aria-valuetext")).toBe("Brief, default"));
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
