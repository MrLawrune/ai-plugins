import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { toast } from "sonner";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DEFAULT_PREFS } from "../prefs.ts";
import type { Prefs, ProfileKey } from "../schemas.ts";
import { DOWN, LOADING, ME, NOT_SET_UP, panelStubs, withPrefs } from "./fixtures.ts";

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
  await screen.findByRole("heading", { name: "Vocabulary" });
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

test("the day count can be cleared and retyped, and saves once on blur", async () => {
  const slot = await panel();
  const days = (await screen.findByLabelText("Keep for")) as HTMLInputElement;
  expect(days.value).toBe("7");
  fireEvent.change(days, { target: { value: "" } });
  expect(days.value).toBe("");
  fireEvent.change(days, { target: { value: "3" } });
  fireEvent.change(days, { target: { value: "30" } });
  await new Promise((r) => setTimeout(r, 800));
  expect(calls(slot, "setPrefs")).toEqual([]);
  fireEvent.blur(days);
  await waitFor(() => expect(calls(slot, "setPrefs")).toEqual([{ profileId: "desktop", patch: { historyMaxAgeDays: 30 } }]));
  expect(days.value).toBe("30");
});

test("Enter saves the day count", async () => {
  const slot = await panel();
  const days = await screen.findByLabelText("Keep for");
  fireEvent.change(days, { target: { value: "14" } });
  fireEvent.keyDown(days, { key: "Enter" });
  await waitFor(() => expect(calls(slot, "setPrefs")).toEqual([{ profileId: "desktop", patch: { historyMaxAgeDays: 14 } }]));
});

test("typing an out-of-range day count key by key never saves a prefix of it", async () => {
  const slot = await panel();
  const days = await screen.findByLabelText("Keep for");
  for (const v of ["1", "12", "120"]) fireEvent.change(days, { target: { value: v } });
  fireEvent.blur(days);
  expect(await screen.findByText("Between 1 and 90 days.")).toBeTruthy();
  await new Promise((r) => setTimeout(r, 800));
  expect(calls(slot, "setPrefs")).toEqual([]);
});

test("history stays mounted while the profile switches", async () => {
  const slot = await panel();
  await screen.findAllByTestId("history-entry");
  fireEvent.change(screen.getByLabelText("Editing profile"), { target: { value: "touch" } });
  await waitFor(() => expect(calls(slot, "getPrefs")).toContainEqual({ profileId: "touch" }));
  expect(screen.getAllByTestId("history-entry")).toHaveLength(3);
  await screen.findByRole("slider", { name: "Entries to keep" });
  expect(calls(slot, "listHistory")).toHaveLength(1);
});

test("loading the roster happens once, not on every render", async () => {
  const slot = await panel();
  await screen.findByRole("heading", { name: "Vocabulary" });
  vi.useFakeTimers();
  try {
    await vi.advanceTimersByTimeAsync(3_000);
  } finally {
    vi.useRealTimers();
  }
  expect(calls(slot, "hello")).toHaveLength(1);
  expect(calls(slot, "listProfiles")).toHaveLength(1);
});

test("Retry after a failed first load shows the settings", async () => {
  let first = true;
  await panel({ hello: () => { if (first) { first = false; throw new Error("backend busy"); } return { device: ME, prefs: DEFAULT_PREFS }; } });
  expect(await screen.findByText(/Couldn't load settings: backend busy/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "Vocabulary" })).toBeTruthy();
  expect(screen.queryByText(/Couldn't load settings/)).toBeNull();
});

test("a dismiss the server did not record keeps the note and says so", async () => {
  const error = vi.spyOn(toast, "error").mockImplementation(() => "");
  const slot = await panel({ getNote: () => ({ note: "Moved." }), dismissNote: () => { throw new Error("kv locked"); } });
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(error).toHaveBeenCalledWith("kv locked"));
  expect(calls(slot, "dismissNote")).toHaveLength(1);
  expect(screen.getByText("Moved.")).toBeTruthy();
  error.mockRestore();
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
  await screen.findAllByTestId("history-entry");
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
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

// Typed over every key outside PROFILE_KEYS: a new shared pref fails to compile until it has a row here.
const SHARED_ROWS: Record<Exclude<keyof Prefs, ProfileKey>, string> = {
  customWords: "Custom words",
  removeFillers: "Remove filler words",
  correctionThreshold: "Correction strength",
  historyMaxEntries: "Entries to keep",
  historyMaxAgeDays: "Keep for",
  sendPhrase: "Send phrase",
  stopPhrase: "Stop phrase",
  clearPhrase: "Clear phrase",
  startPhrases: "Start phrases",
};

const rowText = (label: string) => screen.getByText(label, { selector: "label" }).parentElement!.textContent ?? "";

test.each(Object.entries(SHARED_ROWS))("the shared setting %s says it applies to all profiles", async (_key, label) => {
  await panel(withPrefs({ voiceCommands: true, waitForStart: true }));
  await screen.findByRole("heading", { name: "Vocabulary" });
  expect(rowText(label)).toMatch(/all profiles/i);
});

test("per-profile settings do not claim to be shared", async () => {
  await panel(withPrefs({ voiceCommands: true, waitForStart: true }));
  await screen.findByRole("heading", { name: "Vocabulary" });
  for (const label of ["Hold to talk", "Live preview", "Pause before commit", "Voice commands", "Wait for a start phrase"]) {
    expect(rowText(label)).not.toMatch(/all profiles/i);
  }
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
