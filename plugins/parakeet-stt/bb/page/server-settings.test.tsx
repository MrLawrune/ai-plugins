import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DOWN, NOT_SET_UP, SERVER, UP } from "./fixtures.ts";

type Stubs = Record<string, (input: never) => unknown>;

async function settings(stubs: Stubs = {}) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const section = app.settingsSections.find((s) => s.id === "server")!;
  const view = renderSlot(section, {}, { rpc: { health: () => UP, getServer: () => SERVER, setServer: () => SERVER, ...stubs } });
  return { section, view };
}

const calls = (view: Awaited<ReturnType<typeof settings>>["view"], method: string) =>
  view.inspection.rpcCalls.filter((c) => c.method === method).map((c) => c.input);

test("registers a Server settings section", async () => {
  const { section } = await settings();
  expect(section.title).toBe("Server");
});

test("shows the connected line with model, version and latency", async () => {
  await settings();
  expect(await screen.findByText("Connected · parakeet-tdt-0.6b · 1.4.0 · 320 ms")).toBeTruthy();
});

test("shows Not set up when no server is configured", async () => {
  await settings({ health: () => NOT_SET_UP, getServer: () => ({ ...SERVER, serverUrl: "" }) });
  expect(await screen.findByText("Not set up")).toBeTruthy();
});

test("shows why the server cannot be reached", async () => {
  await settings({ health: () => DOWN });
  expect(await screen.findByText("Can't reach the server: connection refused")).toBeTruthy();
});

test("the URL field starts with the saved URL", async () => {
  await settings();
  const url = (await screen.findByLabelText("Server URL")) as HTMLInputElement;
  await waitFor(() => expect(url.value).toBe("https://stt.example"));
});

test("an invalid URL shows the error and is not saved", async () => {
  const { view } = await settings();
  const url = await screen.findByLabelText("Server URL");
  fireEvent.change(url, { target: { value: "ftp://stt.example" } });
  fireEvent.blur(url);
  expect(await screen.findByText("Enter an http or https URL")).toBeTruthy();
  expect(calls(view, "setServer")).toEqual([]);
});

test("a valid URL is saved on blur, trimmed, and health is re-checked", async () => {
  const { view } = await settings({ setServer: ({ serverUrl }: { serverUrl: string }) => ({ ...SERVER, serverUrl }) });
  const url = (await screen.findByLabelText("Server URL")) as HTMLInputElement;
  await waitFor(() => expect(url.value).toBe("https://stt.example"));
  const healthBefore = calls(view, "health").length;
  fireEvent.change(url, { target: { value: " http://stt.example:9000 " } });
  fireEvent.blur(url);
  await waitFor(() => expect(calls(view, "setServer")).toEqual([{ serverUrl: "http://stt.example:9000" }]));
  await waitFor(() => expect(calls(view, "health").length).toBeGreaterThan(healthBefore));
  expect(url.value).toBe("http://stt.example:9000");
});

test("Enter then leaving the URL field saves once", async () => {
  const { view } = await settings();
  const url = await screen.findByLabelText("Server URL");
  fireEvent.change(url, { target: { value: "http://stt.example:9000" } });
  fireEvent.keyDown(url, { key: "Enter" });
  fireEvent.blur(url);
  await waitFor(() => expect(calls(view, "setServer")).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 50));
  expect(calls(view, "setServer")).toHaveLength(1);
});

test("an unchanged URL is not saved", async () => {
  const { view } = await settings();
  const url = (await screen.findByLabelText("Server URL")) as HTMLInputElement;
  await waitFor(() => expect(url.value).toBe("https://stt.example"));
  fireEvent.blur(url);
  await new Promise((r) => setTimeout(r, 30));
  expect(calls(view, "setServer")).toEqual([]);
});

test("the handler's error is shown beside the URL field", async () => {
  await settings({ setServer: () => { throw new Error("settings are locked"); } });
  const url = await screen.findByLabelText("Server URL");
  fireEvent.change(url, { target: { value: "http://stt.example:9000" } });
  fireEvent.blur(url);
  expect(await screen.findByText("settings are locked")).toBeTruthy();
});

test("the API key field never shows the stored key and Save sends a typed one", async () => {
  const { view } = await settings({ getServer: () => ({ ...SERVER, apiKeySet: true }), setServer: () => ({ ...SERVER, apiKeySet: true }) });
  const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
  expect(key.type).toBe("password");
  await waitFor(() => expect(key.placeholder).toBe("Set"));
  expect(key.value).toBe("");
  fireEvent.change(key, { target: { value: "s3cret-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls(view, "setServer")).toEqual([{ apiKey: "s3cret-key" }]));
  await waitFor(() => expect(key.value).toBe(""));
  expect(document.body.innerHTML.includes("s3cret-key")).toBe(false);
});

test("the API key placeholder says Not set when there is none, and Save needs a typed key", async () => {
  await settings();
  const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
  await waitFor(() => expect(key.placeholder).toBe("Not set"));
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(true);
});

test("Clear removes the stored key", async () => {
  const { view } = await settings({ getServer: () => ({ ...SERVER, apiKeySet: true }), setServer: () => SERVER });
  const clear = (await screen.findByRole("button", { name: "Clear" })) as HTMLButtonElement;
  await waitFor(() => expect(clear.disabled).toBe(false));
  fireEvent.click(clear);
  await waitFor(() => expect(calls(view, "setServer")).toEqual([{ apiKey: null }]));
  const key = screen.getByLabelText("API key") as HTMLInputElement;
  await waitFor(() => expect(key.placeholder).toBe("Not set"));
});

test("Check forces one health call", async () => {
  const { view } = await settings();
  await screen.findByText(/^Connected/);
  const before = calls(view, "health").length;
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  await waitFor(() => expect(calls(view, "health").length).toBe(before + 1));
});

test("tells the user to reload once a URL was set after setup was needed", async () => {
  await settings({ getServer: () => ({ ...SERVER, needsReload: true }) });
  expect(await screen.findByText("Reload the plugin to clear the setup badge")).toBeTruthy();
});

test("no reload notice when nothing needs it", async () => {
  await settings();
  await screen.findByText(/^Connected/);
  expect(screen.queryByText("Reload the plugin to clear the setup badge")).toBeNull();
});

test("Open dictation settings goes to the plugin panel", async () => {
  const { view } = await settings();
  fireEvent.click(await screen.findByRole("button", { name: "Open dictation settings" }));
  expect(view.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "parakeet" }]);
});
