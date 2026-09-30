import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcStubs } from "./fixtures.ts";

async function panel(overrides = {}) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpcStubs(overrides) });
}

test("sections appear in listening-first order", async () => {
  await panel();
  const headings = await screen.findAllByRole("heading", { level: 2 });
  expect(headings.map((h) => h.textContent)).toEqual(["Listening", "Voice", "Sounds", "Where it plays"]);
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
      health: { up: false, error: "unreachable" },
      setup: { state: "downloading-models", detail: null, progress: 0.42, fixCommand: null, headless: null, gpuAvailable: false },
      clients: [],
    }),
  });
  expect(await screen.findByText(/Downloading voice model 42%/)).toBeTruthy();
  expect(screen.getAllByText(/Settings › Plugins › Kokoro TTS/).length).toBeGreaterThan(0);
  expect(screen.queryByText("unreachable")).toBeNull();
});
