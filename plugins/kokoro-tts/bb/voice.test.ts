import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { KokoroClient } from "./kokoro-client.ts";
import { DEFAULT_PREFS } from "./prefs.ts";
import type { Prefs } from "./schemas.ts";
import { registerVoice } from "./voice.ts";

function harness(prefs: Partial<Prefs> = {}, replies: Record<string, unknown> = {}, ready = true) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const hubCalls: unknown[][] = [];
  const readyListeners: ((ready: boolean) => void)[] = [];
  const client: KokoroClient = {
    baseUrl: "http://127.0.0.1:6789",
    async call<T>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      return (replies[path] ?? { action: "silent" }) as T;
    },
    async *synthesize() {},
  };
  const host = createFakePluginHost();
  registerVoice(host.bb, {
    client: () => client,
    hub: {
      speak: (...a) => { hubCalls.push(["speak", ...a]); },
      sound: (...a) => { hubCalls.push(["sound", ...a]); },
      stop: (...a) => { hubCalls.push(["stop", ...a]); },
      hasReadyClient: () => ready,
      onReadyChange: (fn) => { readyListeners.push(fn); return () => undefined; },
    },
    prefs: { get: () => ({ ...DEFAULT_PREFS, ...prefs }) },
    contract: "Mode: {{MODE}}.",
    contractFull: "Full: {{MODE}}, no blocks.",
  });
  return { host, calls, hubCalls, readyListeners, setReady: (r: boolean) => { ready = r; } };
}

const root = (id = "t1") => makeThreadResponse({ id, parentThreadId: null });

test("thread.idle in client mode routes speech to the hub", async () => {
  const { host, calls, hubCalls } = harness({}, {
    "/turn": { action: "speech", text: "Done.", entry_id: 5, speech_gain: 0.8 },
  });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.deepEqual(calls.at(-1), {
    method: "POST", path: "/turn", body: { text: "Done.", session_id: "t1", playback: "client", source: "bb" },
  });
  assert.deepEqual(hubCalls, [["speak", 5, "Done.", "t1", 0.8]]);
});

test("thread.idle in server mode lets the server play", async () => {
  const { host, calls, hubCalls } = harness({ playback: "server" }, { "/turn": { action: "speech", text: "Done." } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.equal((calls.at(-1)?.body as { playback: string }).playback, "server");
  assert.deepEqual(hubCalls, []);
});

test("thread.idle for a child thread is ignored", async () => {
  const { host, calls } = harness();
  await host.harness.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "c1", parentThreadId: "t1" }), lastAssistantText: "Child done.",
  });
  assert.deepEqual(calls, []);
});

test("client mode with no ready window leaves the turn to the hooks", async () => {
  const { host, calls } = harness({}, {}, false);
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.deepEqual(calls, []);
});

test("heartbeat reports whether the plugin can voice", async () => {
  const { host, calls } = harness({}, { "/config": { config: { mode: "verbose" } } }, false);
  const { controller, done } = host.harness.runService("voice-heartbeat");
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await done;
  assert.deepEqual(calls.find((c) => c.path === "/runtime")?.body, { bb_plugin: false });
  assert.equal(host.harness.registrations.instructionProvider?.({ threadId: "t1", projectId: "p1" }), "Mode: verbose.");
});

test("full mode swaps in the short contract without blocks", async () => {
  const { host } = harness({}, { "/config": { config: { mode: "full" } } });
  const { controller, done } = host.harness.runService("voice-heartbeat");
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await done;
  assert.equal(host.harness.registrations.instructionProvider?.({ threadId: "t1", projectId: "p1" }), "Full: full, no blocks.");
});

test("a readiness change posts /runtime immediately", async () => {
  const { calls, readyListeners, setReady } = harness({}, {}, false);
  setReady(true);
  for (const fn of readyListeners) fn(true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [{ method: "POST", path: "/runtime", body: { bb_plugin: true } }]);
});

test("unloading the plugin releases the runtime claim", async () => {
  const { host, calls } = harness();
  await host.harness.dispose();
  assert.deepEqual(calls.at(-1), { method: "POST", path: "/runtime", body: { bb_plugin: false } });
});

test("thread.idle with no text does nothing", async () => {
  const { host, calls } = harness();
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "  " });
  assert.deepEqual(calls, []);
});

test("sound results go to the hub with volume", async () => {
  const { host, hubCalls } = harness({}, { "/turn": { action: "sound", sound: "done", sound_volume: 0.4 } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "x" });
  assert.deepEqual(hubCalls, [["sound", "done", 0.4, "t1"]]);
});

test("malformed server replies are ignored", async () => {
  const { host, hubCalls } = harness({}, { "/turn": { action: "yell" } });
  const { errors } = await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "x" });
  assert.deepEqual(errors, []);
  assert.deepEqual(hubCalls, []);
});

test("thread.active stops client playback", async () => {
  const { host, hubCalls, calls } = harness();
  await host.harness.emitThreadEvent("thread.active", { thread: root() });
  assert.deepEqual(hubCalls, [["stop", "t1"]]);
  assert.deepEqual(calls, []);
});

test("thread.active interrupts server playback", async () => {
  const { host, calls } = harness({ playback: "server" });
  await host.harness.emitThreadEvent("thread.active", { thread: root() });
  assert.deepEqual(calls, [{ method: "POST", path: "/interrupt", body: { session_id: "t1" } }]);
});

test("interaction.pending cues attention", async () => {
  const { host, calls, hubCalls } = harness({}, { "/cue": { action: "sound", sound: "attention", sound_volume: 1 } });
  await host.harness.emitThreadEvent("interaction.pending", { thread: root(), interaction: {} as never });
  assert.deepEqual(calls[0], {
    method: "POST", path: "/cue", body: { sound: "attention", session_id: "t1", playback: "client" },
  });
  assert.deepEqual(hubCalls, [["sound", "attention", 1, "t1"]]);
});

test("archive stops and cleans up", async () => {
  const { host, calls, hubCalls } = harness();
  await host.harness.emitThreadEvent("thread.archived", { thread: root() });
  assert.deepEqual(hubCalls, [["stop", "t1"]]);
  assert.deepEqual(calls, [{ method: "POST", path: "/cleanup", body: { session_id: "t1" } }]);
});

test("instructions carry the contract with the current mode", () => {
  const { host } = harness();
  const provider = host.harness.registrations.instructionProvider;
  assert.equal(provider?.({ threadId: "t1", projectId: "p1" }), "Mode: brief.");
});

import plugin from "./server.ts";

test("server registers the player socket and sound routes", async () => {
  const host = createFakePluginHost();
  await plugin(host.bb);
  const routes = host.harness.registrations.httpRoutes.map((r) => `${r.method} ${r.path}`);
  assert.ok(routes.includes("GET /sound/attention"), routes.join(", "));
  assert.deepEqual(host.harness.registrations.websocketRoutes.map((r) => r.path), ["/player"]);
  const res = await host.harness.fetchHttp("GET", "/sound/done");
  assert.equal(res.headers.get("content-type"), "audio/wav");
});

import { isLocalRequest } from "./server.ts";

test("a player socket is local when its browser's address is this computer's", () => {
  const ours = new Set(["127.0.0.1", "::1", "192.0.2.10"]);
  const h = (o: Record<string, string> = {}) => new Headers(o);
  const url = new URL("http://localhost:4000/x");
  assert.equal(isLocalRequest(url, h(), ours), true, "direct loopback");
  assert.equal(isLocalRequest(new URL("http://[::1]:4000/x"), h(), ours), true);
  assert.equal(isLocalRequest(url, h({ "x-forwarded-for": "192.0.2.10" }), ours), true, "desktop via the reverse proxy");
  assert.equal(isLocalRequest(url, h({ "x-forwarded-for": "::ffff:192.0.2.10, 198.51.100.1" }), ours), true);
  assert.equal(isLocalRequest(url, h({ "x-forwarded-for": "192.0.2.77" }), ours), false, "a phone via the proxy");
  assert.equal(isLocalRequest(new URL("https://bb.example.com/x"), h(), ours), false);
});
