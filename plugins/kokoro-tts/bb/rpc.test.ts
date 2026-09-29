import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ConfigCache } from "./config-cache.ts";
import { ServerError, type KokoroClient } from "./kokoro-client.ts";
import { PrefsStore } from "./prefs.ts";
import { installerFailure, registerRpc } from "./rpc.ts";
import type { ConfigResponse, KokoroStatus, VoiceScopeState } from "./schemas.ts";
import { VoiceScopes } from "./scopes.ts";
import { CONFIG_RESPONSE, HEALTH } from "./page/fixtures.ts";

interface HarnessExtra {
  threadParent?: (threadId: string) => Promise<string | null | undefined>;
}

async function harness(
  playback: "client" | "server" = "server",
  ready = true,
  replies: Record<string, (body: unknown) => unknown> = {},
  extra: HarnessExtra = {},
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const stops: (string | null)[] = [];
  const spoken: unknown[][] = [];
  const sounds: unknown[][] = [];
  const published: [string, unknown][] = [];
  const client: KokoroClient = {
    baseUrl: "http://127.0.0.1:6789",
    async call<T>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (replies[path]) return replies[path]!(body) as T;
      if (path === "/mute") return { muted: (body as { muted: boolean }).muted } as T;
      if (path === "/health") return HEALTH as T;
      if (method === "PATCH" && path === "/config") return { ...CONFIG_RESPONSE, config: { ...CONFIG_RESPONSE.config, ...(body as object) } } as T;
      if (path === "/config") return { config: { speech_gain: 0.8, sound_volume: 0.6 } } as T;
      return { sessions_cancelled: 0, status: "playing" } as T;
    },
    async *synthesize() {},
  };
  const host = createFakePluginHost();
  const prefs = new PrefsStore(host.bb.storage.kv);
  const config = new ConfigCache(() => client.call<ConfigResponse>("GET", "/config"));
  const scopes = new VoiceScopes(host.bb.storage.kv);
  await scopes.load();
  scopes.onChange((kind) => { if (kind === "settings") published.push(["kokoro-scopes", { changed: true }]); });
  registerRpc(host.bb, {
    client: () => client,
    supervisor: () => null,
    prefs,
    config,
    hub: {
      clients: () => [],
      stop: (sessionId) => { stops.push(sessionId); },
      speak: (...a) => { spoken.push(a); },
      sound: (...a) => { sounds.push(a); },
      hasReadyClient: () => ready,
    },
    log: host.bb.log,
    publish: (c, p) => { published.push([c, p]); },
    scopes,
    threadParent: extra.threadParent ?? (async () => null),
  });
  return { host, calls, stops, spoken, sounds, published, config, scopes, ready: prefs.update({ playback }) };
}

test("Stop all also stops browser playback", async () => {
  const { host, calls, stops } = await harness();
  await host.harness.callRpc("interruptAll", null);
  assert.deepEqual(stops, [null]);
  assert.deepEqual(calls.map((c) => c.path), ["/interrupt-all"]);
});

test("Stop on a card stops only that thread, in the browser and on the server", async () => {
  const { host, calls, stops } = await harness();
  await host.harness.callRpc("stop", { threadId: "t1" });
  assert.deepEqual(stops, ["t1"]);
  assert.deepEqual(calls, [{ method: "POST", path: "/interrupt", body: { session_id: "t1" } }]);
});

test("Mute also stops browser playback; unmute does not", async () => {
  const { host, stops, config } = await harness();
  config.set(CONFIG_RESPONSE);
  assert.deepEqual(await host.harness.callRpc("setMuted", { muted: true }), { muted: true });
  assert.deepEqual(stops, [null]);
  assert.equal(config.get()?.muted, true, "the cache learns the mute state");
  await host.harness.callRpc("setMuted", { muted: false });
  assert.deepEqual(stops, [null]);
});

test("the speech log is fetched for one thread", async () => {
  const { host, calls } = await harness("server", true, { "/speech-log?session_id=t%201": () => ({ entries: [] }) });
  assert.deepEqual(await host.harness.callRpc("speechLog", { threadId: "t 1" }), { entries: [] });
  assert.deepEqual(calls.map((c) => c.path), ["/speech-log?session_id=t%201"]);
});

test("installerFailure keeps the last lines of the installer output", () => {
  const out = "downloading uv\n\nerror: curl: (6) Could not resolve host: astral.sh\n";
  assert.equal(
    installerFailure(1, out),
    "the installer exited with code 1 (downloading uv error: curl: (6) Could not resolve host: astral.sh).",
  );
  assert.equal(installerFailure(127, ""), "the installer exited with code 127.");
  assert.ok(installerFailure(1, "x".repeat(1000)).length < 360);
});

test("preview plays in the browser when browser playback is selected", async () => {
  const h = await harness("client");
  await h.ready;
  assert.deepEqual(await h.host.harness.callRpc("preview", { voice: "af_bella", speed: 1.2 }), { status: "playing" });
  assert.equal(h.calls.some((c) => c.path === "/preview"), false);
  const [entryId, text, session, gain, opts] = h.spoken[0] as [number, string, string, number, unknown];
  assert.ok(entryId >= 0xf000_0000);
  assert.equal(text, "This is how I will sound when reading your updates.");
  assert.equal(session, "preview");
  assert.equal(gain, 0.8);
  assert.deepEqual(opts, { voice: "af_bella", speed: 1.2 });
  await h.host.harness.callRpc("preview", {});
  assert.deepEqual(h.calls.map((c) => c.path), ["/config"], "the second preview reads the cached config");
});

test("preview reports no_window when no browser can play", async () => {
  const h = await harness("client", false);
  await h.ready;
  assert.deepEqual(await h.host.harness.callRpc("preview", {}), { status: "no_window" });
  assert.equal(h.spoken.length, 0);
});

test("preview uses the server speakers when server playback is selected", async () => {
  const h = await harness("server");
  await h.ready;
  await h.host.harness.callRpc("preview", { text: "Hello" });
  assert.deepEqual(h.calls.at(-1), { method: "POST", path: "/preview", body: { text: "Hello", session_id: "preview" } });
});

test("sound tests follow browser playback at the configured cue volume", async () => {
  const h = await harness("client");
  await h.ready;
  await h.host.harness.callRpc("playSound", { sound: "done" });
  assert.deepEqual(h.sounds, [["done", 0.6, "bb-preview"]]);
});

test("status bundles health, setup and clients", async () => {
  const h = await harness();
  const s = (await h.host.harness.callRpc("status", null)) as KokoroStatus;
  assert.equal(s.health.up, true);
  assert.equal(s.setup.state, "error"); // no supervisor in this harness
  assert.deepEqual(s.clients, []);
});

test("a config change is published to every window and cached", async () => {
  const h = await harness();
  await h.host.harness.callRpc("patchConfig", { speed: 1.2 });
  const [channel, payload] = h.published.at(-1)!;
  assert.equal(channel, "kokoro-config");
  assert.equal((payload as typeof CONFIG_RESPONSE).config.speed, 1.2);
  assert.equal(h.config.get()?.config.speed, 1.2);
});

test("sound tests use the cached cue volume after a config change", async () => {
  const h = await harness("client");
  await h.ready;
  await h.host.harness.callRpc("patchConfig", { sound_volume: 0.3 });
  await h.host.harness.callRpc("playSound", { sound: "done" });
  assert.deepEqual(h.sounds, [["done", 0.3, "bb-preview"]]);
  assert.equal(h.calls.some((c) => c.method === "GET"), false);
});

test("replay in browser playback speaks the new log entry in that thread", async () => {
  const h = await harness("client", true, {
    "/replay": () => ({ status: "queued", entry_id: 9, text: "Again.", speech_gain: 0.7 }),
  });
  await h.ready;
  assert.deepEqual(await h.host.harness.callRpc("replay", { threadId: "t1", text: "Again." }), { status: "playing" });
  assert.deepEqual(h.calls.at(-1), {
    method: "POST", path: "/replay", body: { text: "Again.", session_id: "t1", playback: "client" },
  });
  assert.deepEqual(h.spoken, [[9, "Again.", "t1", 0.7]]);
});

test("replay reports no_window when no browser can play", async () => {
  const h = await harness("client", false);
  await h.ready;
  assert.deepEqual(await h.host.harness.callRpc("replay", { threadId: "t1", text: "Again." }), { status: "no_window" });
  assert.equal(h.calls.some((c) => c.path === "/replay"), false);
});

test("replay on server playback lets the server play", async () => {
  const h = await harness("server", true, { "/replay": () => ({ status: "playing", session_id: "t1" }) });
  await h.ready;
  assert.deepEqual(await h.host.harness.callRpc("replay", { threadId: "t1", text: "Again." }), { status: "playing" });
  assert.equal((h.calls.at(-1)?.body as { playback: string }).playback, "server");
  assert.deepEqual(h.spoken, []);
});

test("replay passes on a browser-side empty result without speaking", async () => {
  const h = await harness("client", true, { "/replay": () => ({ status: "empty_after_strip" }) });
  await h.ready;
  assert.deepEqual(await h.host.harness.callRpc("replay", { threadId: "t1", text: "**" }), { status: "empty_after_strip" });
  assert.deepEqual(h.spoken, []);
});

test("replay against a server without the endpoint reports unsupported", async () => {
  const h = await harness("server", true, { "/replay": () => { throw new ServerError("Kokoro server returned non-JSON (404)", undefined, 404); } });
  await h.ready;
  assert.deepEqual(await h.host.harness.callRpc("replay", { threadId: "t1", text: "Again." }), { status: "unsupported" });
});

// callRpc returns Promise<unknown>; tsc checks test files.
const scopeRpc = (h: { host: ReturnType<typeof createFakePluginHost> }, name: "getVoiceScope" | "setVoiceScope", input: unknown) =>
  h.host.harness.callRpc(name, input) as Promise<VoiceScopeState>;

test("getVoiceScope looks an unknown parent up once and reports inherited and effective voice", async () => {
  const parentCalls: string[] = [];
  const h = await harness("server", true, {}, { threadParent: async (id) => { parentCalls.push(id); return "t0"; } });
  await h.scopes.set("thread", "t0", { mode: "verbose", voiceChildren: true });
  const r = await scopeRpc(h, "getVoiceScope", { threadId: "c1", projectId: "p1" });
  assert.equal(r.parentThreadId, "t0");
  assert.deepEqual([r.effective.mode, r.effective.voiced, r.effective.modeFrom], ["verbose", true, "parent"]);
  await scopeRpc(h, "getVoiceScope", { threadId: "c1", projectId: "p1" });
  assert.deepEqual(parentCalls, ["c1"]);
});

test("a failed parent lookup resolves as a root and is retried next time", async () => {
  let n = 0;
  const h = await harness("server", true, {}, { threadParent: async () => { n++; throw new Error("down"); } });
  const r = await scopeRpc(h, "getVoiceScope", { threadId: "c1", projectId: "p1" });
  assert.deepEqual([r.parentThreadId, r.effective.isChild], [null, false]);
  await scopeRpc(h, "getVoiceScope", { threadId: "c1", projectId: "p1" });
  assert.equal(n, 2);
  const warnings = h.host.harness.inspection.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /c1.*down/);
});

test("a root is looked up once", async () => {
  let n = 0;
  const h = await harness("server", true, {}, { threadParent: async () => { n++; return null; } });
  await scopeRpc(h, "getVoiceScope", { threadId: "t1", projectId: "p1" });
  await scopeRpc(h, "getVoiceScope", { threadId: "t1", projectId: "p1" });
  assert.equal(n, 1);
});

test("setVoiceScope writes the right scope, null clears, inherited ignores the thread's own mode, and publishes", async () => {
  const h = await harness();
  h.config.set(CONFIG_RESPONSE);
  let r = await scopeRpc(h, "setVoiceScope", { threadId: "t1", projectId: "p1", scope: "project", patch: { mode: "quiet" } });
  assert.deepEqual([r.project, r.effective.voiced], [{ mode: "quiet" }, false]);
  r = await scopeRpc(h, "setVoiceScope", { threadId: "t1", projectId: "p1", scope: "thread", patch: { mode: "brief" } });
  assert.deepEqual([r.thread, r.effective.voiced, r.effective.modeFrom, r.inherited.mode, r.inherited.modeFrom],
    [{ mode: "brief" }, true, "thread", "quiet", "project"]);
  r = await scopeRpc(h, "setVoiceScope", { threadId: "t1", projectId: "p1", scope: "thread", patch: { mode: null } });
  assert.deepEqual(r.thread, {});
  assert.ok(h.published.some(([c]) => c === "kokoro-scopes"));
});

test("getVoiceScope never calls the server: an empty config cache reads as brief", async () => {
  const h = await harness();
  const r = await scopeRpc(h, "getVoiceScope", { threadId: "t1", projectId: "p1" });
  assert.equal(r.globalMode, "brief");
  assert.equal(h.calls.some((c) => c.path === "/config"), false);
});
