import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { CONFIG_RESPONSE, HEALTH, PREFS, READY, RUNTIME, rpcStubs } from "./fixtures.ts";

async function settings(overrides = {}) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  return renderSlot(app.settingsSections[0]!, {}, { rpc: rpcStubs(overrides) });
}

const patches = (slot: Awaited<ReturnType<typeof settings>>) =>
  slot.inspection.rpcCalls.filter((c) => c.method === "patchConfig").map((c) => c.input);

const engines = (main: unknown, backup: unknown = null) =>
  ({ ...CONFIG_RESPONSE, config: { ...CONFIG_RESPONSE.config, engines: { main, backup } } });

test("recovery controls work while the server is down", async () => {
  await settings({
    status: () => ({ ...READY, health: { up: false, error: "down" },
      setup: { ...READY.setup, state: "downloading-models", progress: 0.42 } }),
    getConfig: () => ({ ...CONFIG_RESPONSE, runtime: null }),
  });
  expect(await screen.findByText("Downloading voice model 42%")).toBeTruthy();
  expect(screen.getByRole("switch", { name: /Manage server/ })).toBeTruthy();
  expect(await screen.findByRole("radiogroup", { name: "Main engine" })).toBeTruthy();
});

test("while the managed engine is down, the runtime can still be switched", async () => {
  const slot = await settings({
    status: () => ({ ...READY, health: { up: false, error: "down" },
      setup: { ...READY.setup, state: "error", gpuAvailable: true } }),
    getConfig: () => ({ ...CONFIG_RESPONSE, runtime: null }),
    getPrefs: () => ({ ...PREFS, runtime: "gpu" }),
  });
  const runtime = await screen.findByRole("radiogroup", { name: "Runtime" });
  expect(within(runtime).getByRole("radio", { name: "NVIDIA GPU" }).getAttribute("aria-checked")).toBe("true");
  expect(within(runtime).queryByRole("radio", { name: "OpenVINO" })).toBeNull();
  expect(screen.queryByText("Tuning")).toBeNull();
  fireEvent.click(within(runtime).getByRole("radio", { name: "CPU" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.find((c) => c.method === "setPrefs")?.input).toEqual({ runtime: "cpu" }));
  expect(patches(slot)).toEqual([]);
});

test("the runtime picker is hidden when no engine runs on this computer", async () => {
  await settings({ getConfig: () => ({ ...engines({ url: "http://192.0.2.10:6789" }), runtime: null }) });
  await screen.findByRole("radiogroup", { name: "Main engine" });
  expect(screen.queryByRole("radiogroup", { name: "Runtime" })).toBeNull();
  expect(screen.queryByText("Diagnostics")).toBeNull();
});

test("the runtime picker shows the local runtime's provider", async () => {
  await settings();
  const runtime = await screen.findByRole("radiogroup", { name: "Runtime" });
  expect(within(runtime).getByRole("radio", { name: "CPU" }).getAttribute("aria-checked")).toBe("true");
});

test("choosing Another server for the main engine saves the URL on blur", async () => {
  const slot = await settings();
  const main = await screen.findByRole("radiogroup", { name: "Main engine" });
  fireEvent.click(within(main).getByRole("radio", { name: "Another server" }));
  const url = await screen.findByLabelText("Main engine URL");
  expect(patches(slot)).toEqual([]);
  fireEvent.change(url, { target: { value: "http://192.0.2.10:6789" } });
  fireEvent.blur(url);
  await waitFor(() => expect(patches(slot)).toEqual([{ engines: { main: { url: "http://192.0.2.10:6789" }, backup: null } }]));
});

test("Enter then leaving the URL field saves once", async () => {
  const slot = await settings();
  const main = await screen.findByRole("radiogroup", { name: "Main engine" });
  fireEvent.click(within(main).getByRole("radio", { name: "Another server" }));
  const url = await screen.findByLabelText("Main engine URL");
  fireEvent.change(url, { target: { value: "http://192.0.2.10:6789" } });
  fireEvent.keyDown(url, { key: "Enter" });
  fireEvent.blur(url);
  await waitFor(() => expect(patches(slot)).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 50));
  expect(patches(slot)).toHaveLength(1);
});

test("an engine URL that is not http(s) is not saved", async () => {
  const slot = await settings();
  const main = await screen.findByRole("radiogroup", { name: "Main engine" });
  fireEvent.click(within(main).getByRole("radio", { name: "Another server" }));
  const url = await screen.findByLabelText("Main engine URL");
  fireEvent.change(url, { target: { value: "192.0.2.10:6789" } });
  fireEvent.blur(url);
  expect(await screen.findByText(/http:\/\/ or https:\/\//)).toBeTruthy();
  expect(patches(slot)).toEqual([]);
});

test("a backup engine on this computer is saved alongside the main engine", async () => {
  const slot = await settings({ getConfig: () => engines({ url: "http://192.0.2.10:6789" }) });
  const backup = await screen.findByRole("radiogroup", { name: "Backup engine" });
  fireEvent.click(within(backup).getByRole("radio", { name: "This computer (managed)" }));
  await waitFor(() => expect(patches(slot)).toEqual([{ engines: { main: { url: "http://192.0.2.10:6789" }, backup: "local" } }]));
});

test("each engine shows its status, and an open breaker says the backup is in use", async () => {
  await settings({
    getConfig: () => engines({ url: "http://192.0.2.10:6789" }, "local"),
    status: () => ({
      ...READY,
      health: { up: false, error: "connection refused" },
      engines: [
        { slot: "main", url: "http://192.0.2.10:6789", local: false, health: { up: false, error: "connection refused" }, breaker: "open" },
        { slot: "backup", url: "http://127.0.0.1:6789", local: true, health: { up: true, health: { ...HEALTH, version: "1.2.0" } }, breaker: "closed" },
      ],
    }),
  });
  expect(await screen.findByText("Unreachable: connection refused")).toBeTruthy();
  expect(screen.getByText("Breaker open — using backup")).toBeTruthy();
  expect(screen.getByText("Reachable · v1.2.0")).toBeTruthy();
});

test("with no backup, an open breaker says main is being retried", async () => {
  await settings({
    getConfig: () => engines({ url: "http://192.0.2.10:6789" }),
    status: () => ({
      ...READY,
      health: { up: false, error: "connection refused" },
      engines: [{ slot: "main", url: "http://192.0.2.10:6789", local: false, health: { up: false, error: "connection refused" }, breaker: "open" }],
    }),
  });
  expect(await screen.findByText("Main engine unreachable — retrying shortly")).toBeTruthy();
  expect(screen.queryByText("Breaker open — using backup")).toBeNull();
});

test("the latency line reads the plugin's median", async () => {
  await settings({ status: () => ({ ...READY, latency: { median_ms: 412.4, samples: 9 } }) });
  expect(await screen.findByText(/typical first audio 412 ms/)).toBeTruthy();
});

test("a managed runtime change goes through prefs, not a live engine patch", async () => {
  const slot = await settings({
    status: () => ({ ...READY, setup: { ...READY.setup, gpuAvailable: true } }),
  });
  fireEvent.click(await screen.findByRole("radio", { name: "NVIDIA GPU" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "setPrefs")).toBe(true));
  expect(patches(slot)).toEqual([]);
  expect(slot.inspection.rpcCalls.find((c) => c.method === "setPrefs")?.input).toEqual({ runtime: "gpu" });
});

test("switching the managed runtime leaves OpenVINO first", async () => {
  const openvino = { ...RUNTIME, config: { ...RUNTIME.config, provider: "openvino" as const },
    providers_available: { cpu: true, cuda: true, openvino: true } };
  const slot = await settings({
    status: () => ({ ...READY, setup: { ...READY.setup, gpuAvailable: true } }),
    getConfig: () => ({ ...CONFIG_RESPONSE, runtime: openvino }),
  });
  const runtime = await screen.findByRole("radiogroup", { name: "Runtime" });
  await waitFor(() => expect(within(runtime).getByRole("radio", { name: "OpenVINO" }).getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(within(runtime).getByRole("radio", { name: "NVIDIA GPU" }));
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
