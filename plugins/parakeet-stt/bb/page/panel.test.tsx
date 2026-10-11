import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DEFAULT_PREFS } from "../prefs.ts";
import { DOWN, LOADING, NOT_SET_UP, panelStubs, withPrefs } from "./fixtures.ts";

type Stubs = Parameters<typeof panelStubs>[0];

async function panel(overrides: Stubs = {}) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: panelStubs(overrides) });
}

const calls = (slot: Awaited<ReturnType<typeof panel>>, method: string) =>
  slot.inspection.rpcCalls.filter((c) => c.method === method).map((c) => c.input);

test("registers a Dictation nav panel with a status header", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  expect(app.navPanels[0]!.title).toBe("Dictation");
  expect(app.navPanels[0]!.headerContent).toBeTruthy();
});

test("the header shows the server status", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const Header = app.navPanels[0]!.headerContent!;
  renderSlot({ component: Header }, { subPath: "" }, { rpc: panelStubs() });
  expect(await screen.findByText(/^Connected/)).toBeTruthy();
});

test("the header says when the model is still loading", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const Header = app.navPanels[0]!.headerContent!;
  renderSlot({ component: Header }, { subPath: "" }, { rpc: panelStubs({ health: () => LOADING }) });
  expect(await screen.findByText("Loading model…")).toBeTruthy();
});

test("sections appear in the planned order", async () => {
  await panel();
  await screen.findByRole("heading", { name: "History" });
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
    "Devices and profiles", "Dictation", "Continuous dictation", "Voice commands", "Vocabulary", "History",
  ]);
});

test("the footer promises automatic saving", async () => {
  await panel();
  expect(await screen.findByText(/Changes save automatically/)).toBeTruthy();
});

test("no server URL or key fields on this page", async () => {
  await panel();
  await screen.findByText("Dictation");
  expect(screen.queryByLabelText("Server URL")).toBeNull();
  expect(screen.queryByLabelText("API key")).toBeNull();
});

test("without a server the panel points to the Server section", async () => {
  await panel({ health: () => NOT_SET_UP });
  expect(await screen.findByText(/Settings › Plugins › Parakeet STT/)).toBeTruthy();
  expect(screen.getByText("Set up the server to start dictating.")).toBeTruthy();
});

test("with a server that is down the banner is not shown as a setup prompt", async () => {
  await panel({ health: () => DOWN });
  await screen.findByText("Dictation");
  expect(screen.queryByText("Set up the server to start dictating.")).toBeNull();
});

test("choosing the one-shot mode saves it", async () => {
  const slot = await panel();
  fireEvent.click(await screen.findByRole("radio", { name: "One-shot" }));
  await waitFor(() => expect(calls(slot, "setPrefs")).toEqual([{ profileId: "desktop", patch: { mode: "oneshot" } }]));
});

test("a switch saves right away", async () => {
  const slot = await panel();
  fireEvent.click(await screen.findByRole("switch", { name: "Hold to talk" }));
  await waitFor(() => expect(calls(slot, "setPrefs")).toEqual([{ profileId: "desktop", patch: { holdToTalk: true } }]));
});

test("30 slider steps inside the debounce window save once with the last value", async () => {
  const slot = await panel();
  const entries = await screen.findByRole("slider", { name: "Entries to keep" });
  for (let i = 0; i < 30; i++) fireEvent.keyDown(entries, { key: "ArrowRight" });
  expect(calls(slot, "setPrefs")).toEqual([]);
  await waitFor(() => expect(calls(slot, "setPrefs")).toHaveLength(1), { timeout: 2_000 });
  expect(calls(slot, "setPrefs")).toEqual([{ profileId: "desktop", patch: { historyMaxEntries: 350 } }]);
  await new Promise((r) => setTimeout(r, 800));
  expect(calls(slot, "setPrefs")).toHaveLength(1);
});

test("switching profile saves the pending change to the profile it was made on", async () => {
  const slot = await panel();
  const entries = await screen.findByRole("slider", { name: "Entries to keep" });
  fireEvent.keyDown(entries, { key: "ArrowRight" });
  fireEvent.change(screen.getByLabelText("Editing profile"), { target: { value: "touch" } });
  await waitFor(() => expect(calls(slot, "setPrefs")).toEqual([{ profileId: "desktop", patch: { historyMaxEntries: 60 } }]));
  await waitFor(() => expect(calls(slot, "getPrefs")).toContainEqual({ profileId: "touch" }));
  await new Promise((r) => setTimeout(r, 800));
  expect(calls(slot, "setPrefs")).toHaveLength(1);
});

test("the day count can be cleared and retyped without saving the empty field", async () => {
  const slot = await panel();
  const days = (await screen.findByLabelText("Keep for")) as HTMLInputElement;
  expect(days.value).toBe("7");
  fireEvent.change(days, { target: { value: "" } });
  expect(days.value).toBe("");
  fireEvent.change(days, { target: { value: "3" } });
  fireEvent.change(days, { target: { value: "30" } });
  expect(calls(slot, "setPrefs")).toEqual([]);
  await waitFor(() => expect(calls(slot, "setPrefs")).toEqual([{ profileId: "desktop", patch: { historyMaxAgeDays: 30 } }]), { timeout: 2_000 });
  expect(days.value).toBe("30");
});

test("a day count out of range is flagged and not saved", async () => {
  const slot = await panel();
  const days = await screen.findByLabelText("Keep for");
  fireEvent.change(days, { target: { value: "120" } });
  fireEvent.blur(days);
  expect(await screen.findByText("Between 1 and 90 days.")).toBeTruthy();
  await new Promise((r) => setTimeout(r, 800));
  expect(calls(slot, "setPrefs")).toEqual([]);
});

test("the migration note shows and Dismiss clears it", async () => {
  const slot = await panel({ getNote: () => ({ note: "Your 0.1.0 settings were moved." }) });
  expect(await screen.findByText("Your 0.1.0 settings were moved.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(calls(slot, "dismissNote")).toHaveLength(1));
  await waitFor(() => expect(screen.queryByText("Your 0.1.0 settings were moved.")).toBeNull());
});

test("no note, no banner", async () => {
  await panel();
  await screen.findByText("Dictation");
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
});

test("history lists the newest first with its source", async () => {
  await panel();
  const items = await screen.findAllByTestId("history-entry");
  expect(items.map((i) => i.textContent)).toEqual([
    expect.stringContaining("newest words"),
    expect.stringContaining("spoken to the agent"),
    expect.stringContaining("older words"),
  ]);
  expect(items[0]!.textContent).toContain("Continuous");
  expect(items[1]!.textContent).toContain("Voice button");
  expect(items[2]!.textContent).toContain("One-shot");
});

test("an empty history says so", async () => {
  await panel({ listHistory: () => ({ entries: [] }) });
  expect(await screen.findByText("No transcriptions yet.")).toBeTruthy();
});

test("Clear asks first, then clears the history", async () => {
  const slot = await panel();
  fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
  expect(calls(slot, "clearHistory")).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
  await waitFor(() => expect(calls(slot, "clearHistory")).toHaveLength(1));
  expect(await screen.findByText("No transcriptions yet.")).toBeTruthy();
});

test("the shortcut hint explains the command palette entry", async () => {
  await panel();
  const hint = await screen.findByText(/command palette \(Mod\+Shift\+P\)/);
  expect(hint.textContent).toMatch(/any composer/);
  expect(hint.textContent).toMatch(/stops a session running in another composer/);
});

test("shared settings say they apply to every profile", async () => {
  await panel();
  await screen.findByText("Vocabulary");
  const custom = screen.getByLabelText("Custom words").closest("div.grid")!;
  expect(custom.textContent).toMatch(/all profiles/i);
  const entries = screen.getByRole("slider", { name: "Entries to keep" }).closest("div.grid")!;
  expect(entries.textContent).toMatch(/all profiles/i);
});

test("voice command phrases and start phrases appear only when they matter", async () => {
  await panel();
  await screen.findByText("Voice commands", { selector: "h2" });
  expect(screen.queryByLabelText("Send phrase")).toBeNull();
});

test("with voice commands and wait-for-start on, the phrases show", async () => {
  await panel(withPrefs({ voiceCommands: true, waitForStart: true }));
  expect(await screen.findByLabelText("Send phrase")).toBeTruthy();
  expect(screen.getByLabelText("Start phrases")).toBeTruthy();
});

test("custom words are saved on blur as a list", async () => {
  const slot = await panel();
  const words = await screen.findByLabelText("Custom words");
  fireEvent.change(words, { target: { value: "tmux, CLAUDE.md" } });
  expect(calls(slot, "setPrefs")).toEqual([]);
  fireEvent.blur(words);
  await waitFor(() => expect(calls(slot, "setPrefs")).toEqual([{ profileId: "desktop", patch: { customWords: ["tmux", "CLAUDE.md"] } }]));
});

test("a failed save shows the error with a retry", async () => {
  let fail = true;
  const slot = await panel({
    setPrefs: ({ patch }: { patch: object }) => { if (fail) throw new Error("disk full"); return { ...DEFAULT_PREFS, ...patch }; },
  });
  fireEvent.click(await screen.findByRole("switch", { name: "Hold to talk" }));
  expect(await screen.findByText(/Not saved: disk full/)).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
  expect(calls(slot, "setPrefs")).toHaveLength(2);
});
