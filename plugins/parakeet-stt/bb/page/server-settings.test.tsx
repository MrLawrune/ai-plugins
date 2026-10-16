import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DOWN, LOADING, NOT_SET_UP, SERVER, UP } from "./fixtures.ts";

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

test("a server that answered but is still loading its model is not an error", async () => {
  await settings({ health: () => LOADING });
  expect(await screen.findByText("Loading model…")).toBeTruthy();
  expect(screen.queryByText(/Can't reach/)).toBeNull();
});

test("a late getServer does not overwrite what the user already typed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await settings({ getServer: async () => { await gate; return { ...SERVER, needsReload: true }; } });
  const url = (await screen.findByLabelText("Server URL")) as HTMLInputElement;
  fireEvent.change(url, { target: { value: "http://typed.example" } });
  release();
  expect(await screen.findByText("Reload the plugin to clear the setup badge")).toBeTruthy();
  expect(url.value).toBe("http://typed.example");
});

test("a whitespace-only API key cannot be saved and a typed one is sent trimmed", async () => {
  const { view } = await settings();
  const key = await screen.findByLabelText("API key");
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  fireEvent.change(key, { target: { value: "   " } });
  expect(save.disabled).toBe(true);
  fireEvent.keyDown(key, { key: "Enter" });
  expect(calls(view, "setServer")).toEqual([]);
  fireEvent.change(key, { target: { value: " abc123\n" } });
  expect(save.disabled).toBe(false);
});

test("Enter in the API key field saves it", async () => {
  const { view } = await settings();
  const key = await screen.findByLabelText("API key");
  fireEvent.change(key, { target: { value: "abc123" } });
  fireEvent.keyDown(key, { key: "Enter" });
  await waitFor(() => expect(calls(view, "setServer")).toEqual([{ apiKey: "abc123" }]));
});

/** A promise and its resolver, to hold an RPC answer until the test says so. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
};

test("typing while a URL save is pending keeps the newer input and saves it next", async () => {
  const g = gate();
  const { view } = await settings({
    setServer: async ({ serverUrl }: { serverUrl: string }) => { if (serverUrl === "http://one.example") await g.opened; return { ...SERVER, serverUrl }; },
  });
  const url = (await screen.findByLabelText("Server URL")) as HTMLInputElement;
  await waitFor(() => expect(url.value).toBe("https://stt.example"));
  fireEvent.change(url, { target: { value: "http://one.example" } });
  fireEvent.blur(url);
  fireEvent.change(url, { target: { value: "http://two.example" } });
  g.open();
  await new Promise((r) => setTimeout(r, 30));
  expect(url.value).toBe("http://two.example");
  fireEvent.blur(url);
  await waitFor(() => expect(calls(view, "setServer")).toEqual([{ serverUrl: "http://one.example" }, { serverUrl: "http://two.example" }]));
  await waitFor(() => expect(url.value).toBe("http://two.example"));
});

test("an older save that completes last does not replace the newer result", async () => {
  const first = gate();
  const { view } = await settings({
    setServer: async ({ serverUrl }: { serverUrl: string }) => { if (serverUrl === "http://one.example") await first.opened; return { ...SERVER, serverUrl }; },
  });
  const url = (await screen.findByLabelText("Server URL")) as HTMLInputElement;
  await waitFor(() => expect(url.value).toBe("https://stt.example"));
  fireEvent.change(url, { target: { value: "http://one.example" } });
  fireEvent.blur(url);
  fireEvent.change(url, { target: { value: "http://two.example" } });
  fireEvent.blur(url);
  await waitFor(() => expect(calls(view, "setServer")).toHaveLength(2));
  first.open();
  await new Promise((r) => setTimeout(r, 30));
  expect(url.value).toBe("http://two.example");
  fireEvent.blur(url);
  await new Promise((r) => setTimeout(r, 30));
  expect(calls(view, "setServer")).toHaveLength(2); // the saved URL is still the newer one: nothing to save
});

test("the initial getServer answering after a key save does not bring back Not set", async () => {
  const g = gate();
  await settings({
    getServer: async () => { await g.opened; return SERVER; },
    setServer: () => ({ ...SERVER, apiKeySet: true }),
  });
  const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
  fireEvent.change(key, { target: { value: "abc123" } });
  fireEvent.keyDown(key, { key: "Enter" });
  await waitFor(() => expect(key.placeholder).toBe("Set"));
  g.open();
  await new Promise((r) => setTimeout(r, 30));
  expect(key.placeholder).toBe("Set");
});

test("a key save that completes clears only the key text it sent", async () => {
  const g = gate();
  await settings({ setServer: async () => { await g.opened; return { ...SERVER, apiKeySet: true }; } });
  const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
  fireEvent.change(key, { target: { value: "abc" } });
  fireEvent.keyDown(key, { key: "Enter" });
  fireEvent.change(key, { target: { value: "abcdef" } });
  g.open();
  await waitFor(() => expect(key.placeholder).toBe("Set"));
  expect(key.value).toBe("abcdef");
});

test("a key save answering before the initial load still leaves the URL shown, and a blur sends nothing", async () => {
  const g = gate();
  const { view } = await settings({
    getServer: async () => { await g.opened; return SERVER; },
    setServer: () => ({ ...SERVER, apiKeySet: true }),
  });
  const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
  fireEvent.change(key, { target: { value: "abc123" } });
  fireEvent.keyDown(key, { key: "Enter" });
  await waitFor(() => expect(key.placeholder).toBe("Set"));
  const url = screen.getByLabelText("Server URL") as HTMLInputElement;
  fireEvent.focus(url);
  fireEvent.blur(url); // never loaded, never touched: nothing to save
  g.open();
  await waitFor(() => expect(url.value).toBe("https://stt.example"));
  fireEvent.focus(url);
  fireEvent.blur(url);
  await new Promise((r) => setTimeout(r, 30));
  expect(calls(view, "setServer")).toEqual([{ apiKey: "abc123" }]);
});

test("a blank URL field that was never loaded is not saved on blur", async () => {
  const g = gate();
  const { view } = await settings({ getServer: async () => { await g.opened; return SERVER; } });
  const url = (await screen.findByLabelText("Server URL")) as HTMLInputElement;
  fireEvent.focus(url);
  fireEvent.blur(url);
  fireEvent.keyDown(url, { key: "Enter" });
  await new Promise((r) => setTimeout(r, 30));
  expect(calls(view, "setServer")).toEqual([]);
});

test("a pending Clear keeps a new key typed since it was issued", async () => {
  const g = gate();
  const { view } = await settings({
    getServer: () => ({ ...SERVER, apiKeySet: true }),
    setServer: async () => { await g.opened; return SERVER; },
  });
  const clear = (await screen.findByRole("button", { name: "Clear" })) as HTMLButtonElement;
  await waitFor(() => expect(clear.disabled).toBe(false));
  const key = screen.getByLabelText("API key") as HTMLInputElement;
  fireEvent.click(clear);
  fireEvent.change(key, { target: { value: "new-key" } });
  g.open();
  await waitFor(() => expect(key.placeholder).toBe("Not set"));
  expect(calls(view, "setServer")).toEqual([{ apiKey: null }]);
  expect(key.value).toBe("new-key");
});
