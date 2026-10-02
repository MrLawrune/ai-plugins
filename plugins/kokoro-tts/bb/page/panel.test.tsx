import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { CONFIG_RESPONSE, HEALTH, READY, rpcStubs } from "./fixtures.ts";

async function panel(overrides = {}) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpcStubs(overrides) });
}

test("sections appear in listening-first order", async () => {
  await panel();
  const headings = await screen.findAllByRole("heading", { level: 2 });
  expect(headings.map((h) => h.textContent)).toEqual(["Listening", "Voice", "Sounds", "History", "Where it plays"]);
});

test("choosing a mode with the keyboard saves it", async () => {
  const slot = await panel();
  const mode = await screen.findByRole("slider", { name: "Mode" });
  expect(mode.getAttribute("aria-valuetext")).toBe("Brief");
  fireEvent.keyDown(mode, { key: "ArrowRight" });
  await waitFor(() => {
    expect(slot.inspection.rpcCalls.some((c) => c.method === "patchConfig" && (c.input as { mode?: string }).mode === "conversational")).toBe(true);
  });
});

test("two sliders moved quickly are saved together", async () => {
  const slot = await panel();
  fireEvent.keyDown(await screen.findByRole("slider", { name: "Speed" }), { key: "ArrowRight" });
  fireEvent.keyDown(screen.getByRole("slider", { name: "Speech volume" }), { key: "ArrowRight" });
  await waitFor(() => {
    const patches = slot.inspection.rpcCalls.filter((c) => c.method === "patchConfig").map((c) => c.input as object);
    expect(patches).toEqual([{ speed: 1.05, speech_gain: 1.05 }]);
  }, { timeout: 2_000 });
});

test("picking a voice also sets its language", async () => {
  // Select popovers are awkward in jsdom; drive the handler through the exported helper instead.
  const { voicePatch } = await import("./voice-section.tsx");
  expect(voicePatch("bm_george", [{ name: "bm_george", lang_code: "b", lang: "en-gb", language: "British English", gender: "male" }]))
    .toEqual({ voice: "bm_george", lang: "en-gb" });
});

test("while the server is setting up, the panel explains where to look", async () => {
  await panel({
    status: () => ({
      ...READY,
      health: { up: false, error: "unreachable" },
      engines: [{ ...READY.engines[0]!, health: { up: false, error: "unreachable" } }],
      setup: { state: "downloading-models", detail: null, progress: 0.42, fixCommand: null, headless: null, gpuAvailable: false },
    }),
  });
  expect(await screen.findByText(/Downloading voice model 42%/)).toBeTruthy();
  expect(screen.getAllByText(/Settings › Plugins › Kokoro TTS/).length).toBeGreaterThan(0);
  expect(screen.queryByText("unreachable")).toBeNull();
});

const patches = (slot: Awaited<ReturnType<typeof panel>>) =>
  slot.inspection.rpcCalls.filter((c) => c.method === "patchConfig").map((c) => c.input);

test("history limits outside their range are not saved", async () => {
  const slot = await panel();
  const days = await screen.findByLabelText("Keep history for");
  fireEvent.change(days, { target: { value: "0" } });
  fireEvent.blur(days);
  expect(await screen.findByText("Between 1 and 90 days.")).toBeTruthy();
  const entries = screen.getByLabelText("Keep at most");
  fireEvent.change(entries, { target: { value: "50" } });
  fireEvent.blur(entries);
  expect(await screen.findByText("Between 100 and 10000 entries.")).toBeTruthy();
  expect(patches(slot)).toEqual([]);

  fireEvent.change(days, { target: { value: "30" } });
  fireEvent.blur(days);
  await waitFor(() => expect(patches(slot)).toEqual([{ retention: { maxAgeDays: 30, maxEntries: 1000 } }]));
});

test("Clear history asks first, then clears the log", async () => {
  const slot = await panel({ clearHistory: () => ({ deleted: 3 }) });
  fireEvent.click(await screen.findByRole("button", { name: "Clear history" }));
  expect(slot.inspection.rpcCalls.some((c) => c.method === "clearHistory")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.filter((c) => c.method === "clearHistory")).toHaveLength(1));
  expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
});

test("a settings note shows above the sections until dismissed", async () => {
  const slot = await panel({ getConfig: () => ({ ...CONFIG_RESPONSE, note: "Audio now plays in a bb window." }) });
  expect(await screen.findByText("Audio now plays in a bb window.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "dismissNote")).toBe(true));
  await waitFor(() => expect(screen.queryByText("Audio now plays in a bb window.")).toBeNull());
});

test("there is no server playback or output device choice", async () => {
  await panel();
  await screen.findByRole("heading", { name: "Where it plays" });
  expect(screen.queryByLabelText("Play audio")).toBeNull();
  expect(screen.queryByText("Rescan devices")).toBeNull();
  expect(screen.getByLabelText("Route")).toBeTruthy();
});

const MAIN_DOWN_BACKUP_UP = {
  ...READY,
  health: { up: false, error: "ECONNREFUSED" },
  engines: [
    { slot: "main", url: "http://192.0.2.10:6789", local: false, health: { up: false, error: "ECONNREFUSED" }, breaker: "open" },
    { slot: "backup", url: "http://127.0.0.1:6789", local: true, health: { up: true, health: HEALTH }, breaker: "closed" },
  ],
};

test("with the main engine down and the backup up, voices load and no 'nothing can speak' banner shows", async () => {
  const slot = await panel({ status: () => MAIN_DOWN_BACKUP_UP });
  await screen.findByRole("heading", { name: "Voice" });
  await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "listVoices")).toBe(true));
  expect(screen.queryByText(/Speech plays once an engine is running/)).toBeNull();
});

test("with every engine down the banner shows and voices wait", async () => {
  const slot = await panel({
    status: () => ({ ...MAIN_DOWN_BACKUP_UP, engines: MAIN_DOWN_BACKUP_UP.engines.map((e) => ({ ...e, health: { up: false, error: "down" } })) }),
  });
  expect(await screen.findByText(/Speech plays once an engine is running/)).toBeTruthy();
  expect(slot.inspection.rpcCalls.some((c) => c.method === "listVoices")).toBe(false);
});
