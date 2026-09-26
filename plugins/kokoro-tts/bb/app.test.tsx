import { expect, test } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

test("registers the Kokoro TTS panel", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  expect(app.navPanels.map((p) => p.id)).toEqual(["kokoro-tts"]);
});
