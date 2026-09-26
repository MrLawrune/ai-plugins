import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { CONFIG_RESPONSE, HEALTH, READY, rpcStubs } from "./fixtures.ts";

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
  expect(slot.inspection.rpcCalls.find((c) => c.method === "setPrefs")?.input).toEqual({ runtime: "gpu" });
});

test("switching the managed runtime leaves a remote engine first", async () => {
  const slot = await settings({
    status: () => ({ ...READY, setup: { ...READY.setup, gpuAvailable: true } }),
    getConfig: () => ({ ...CONFIG_RESPONSE, config: { ...CONFIG_RESPONSE.config, provider: "remote", remote_url: "http://192.0.2.10:6789" } }),
  });
  await screen.findByLabelText("Remote node URL"); // config has loaded and shows the remote engine
  fireEvent.click(await screen.findByRole("radio", { name: "NVIDIA GPU" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "setPrefs")).toBe(true));
  const calls = slot.inspection.rpcCalls.filter((c) => c.method === "patchConfig" || c.method === "setPrefs");
  expect(calls.map((c) => [c.method, c.input])).toEqual([
    ["patchConfig", { provider: "cpu" }],
    ["setPrefs", { runtime: "gpu" }],
  ]);
});

test("paths are shown relative to home", async () => {
  await settings();
  fireEvent.click(await screen.findByText("Diagnostics"));
  expect(screen.getByText("~/.config/kokoro-tts/config.json")).toBeTruthy();
});

test("a remote engine's last error and latency are shown under the remote form", async () => {
  const remote = { kind: "remote", provider: "remote", url: "http://192.0.2.10:6789", last_error: "connection refused",
    last_latency_ms: 120, fallback: null };
  await settings({
    status: () => ({ ...READY, health: { up: true, health: { ...HEALTH, engine: remote } } }),
    getConfig: () => ({ ...CONFIG_RESPONSE, config: { ...CONFIG_RESPONSE.config, provider: "remote", remote_url: "http://192.0.2.10:6789" } }),
  });
  expect(await screen.findByText(/connection refused/)).toBeTruthy();
  expect(screen.getByText(/120 ms/)).toBeTruthy();
});
