import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { READY, rpcStubs } from "./fixtures.ts";

async function settings(overrides = {}) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  return renderSlot(app.settingsSections[0]!, {}, { rpc: rpcStubs(overrides) });
}

test("recovery controls work while the server is down", async () => {
  await settings({
    status: () => ({ ...READY, health: { up: false, error: "down" },
      setup: { ...READY.setup, state: "downloading-models", progress: 0.42 } }),
    getConfig: () => { throw new Error("server down"); },
  });
  expect(await screen.findByText("Downloading voice model 42%")).toBeTruthy();
  expect(screen.getByRole("switch", { name: /Manage server/ })).toBeTruthy();
  expect(screen.getByRole("radio", { name: "CPU" })).toBeTruthy();
});

test("choosing Remote node reveals the URL form without saving anything", async () => {
  const slot = await settings();
  fireEvent.click(await screen.findByRole("radio", { name: "Remote node" }));
  const url = await screen.findByLabelText("Remote node URL");
  expect(slot.inspection.rpcCalls.some((c) => c.method === "patchConfig")).toBe(false);
  fireEvent.change(url, { target: { value: "http://192.0.2.10:6789" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => {
    const call = slot.inspection.rpcCalls.find((c) => c.method === "patchConfig");
    expect(call?.input).toEqual({ provider: "remote", remote_url: "http://192.0.2.10:6789", fallback_to_cpu: true });
  });
});

test("a managed runtime change goes through prefs, not a live engine patch", async () => {
  const slot = await settings({
    status: () => ({ ...READY, setup: { ...READY.setup, gpuAvailable: true } }),
  });
  fireEvent.click(await screen.findByRole("radio", { name: "NVIDIA GPU" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "setPrefs")).toBe(true));
  expect(slot.inspection.rpcCalls.some((c) => c.method === "patchConfig")).toBe(false);
});

test("paths are shown relative to home", async () => {
  await settings();
  fireEvent.click(await screen.findByText("Diagnostics"));
  expect(screen.getByText("~/.config/kokoro-tts/config.json")).toBeTruthy();
});
