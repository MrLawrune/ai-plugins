import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MuteStore, SettingsStore } from "./coord/settings.ts";
import { SpeechLogStore } from "./coord/speech-log.ts";
import { EngineChain } from "./engines/chain.ts";
import { EngineError, type Engine, type EngineHealth } from "./engines/types.ts";
import { LoadScope } from "./lifecycle.ts";
import { PrefsStore } from "./prefs.ts";
import { installerFailure, registerRpc, type RpcDeps } from "./rpc.ts";
import type { ConfigResponse, KokoroStatus, Settings, VoiceInfo, VoiceScopeState } from "./schemas.ts";
import { VoiceScopes } from "./scopes.ts";

// Every host a test makes is disposed after it, pass or fail.
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

const LOCAL = "http://127.0.0.1:6789";
const VOICES: VoiceInfo[] = [{ name: "af_sky", lang_code: "a", lang: "en-us", language: "American English", gender: "female" }];
const UP: EngineHealth = { reachable: true, loaded: true, version: "0.3.4", forwards: false, error: null };
const DOWN: EngineHealth = { reachable: false, loaded: null, version: null, forwards: null, error: "ECONNREFUSED" };

/** The local Python server's GET/PATCH /config body. */
const LOCAL_CONFIG = {
  config: {
    provider: "remote", idle_unload_minutes: 10, intra_op_threads: 0, gpu_mem_limit_mb: 0,
    voice: "af_sky", speed: 1, remote_url: "http://gpu:6789",
  },
  muted: false,
  providers_available: { cpu: true, cuda: false, openvino: false },
  restart_required: { model_path: "/m.onnx", voices_path: "/v.bin", port: 6789, config_path: "/c.json" },
  restart_command: "Turn Manage server off and on again.",
};

interface FakeEngine extends Engine {
  health: (signal: AbortSignal) => Promise<EngineHealth>;
}

function fakeEngine(url: string, o: { health?: EngineHealth; voices?: VoiceInfo[] | Error } = {}): FakeEngine {
  return {
    url,
    health: async () => o.health ?? UP,
    voices: async () => {
      if (o.voices instanceof Error) throw o.voices;
      return o.voices ?? VOICES;
    },
    synthesize: async function* () {},
  };
}

interface Options {
  ready?: boolean;
  settings?: Partial<Settings>;
  main?: FakeEngine;
  backup?: FakeEngine | null;
  /** The local server's /config; null = unreachable. */
  local?: typeof LOCAL_CONFIG | null;
  /** Answer for PATCH /config on the local server. */
  patchReply?: (body: unknown) => Response;
  /** PATCH /config never answers; it settles only when its request is aborted. */
  hangPatch?: boolean;
  threadParent?: (threadId: string) => Promise<string | null | undefined>;
  threadExists?: (threadId: string) => Promise<boolean>;
  replay?: RpcDeps["turns"]["replay"];
  installUv?: RpcDeps["installUv"];
}

async function harness(o: Options = {}) {
  const host = createFakePluginHost();
  hosts.push(host);
  const kv = host.bb.storage.kv;
  const settings = new SettingsStore(kv);
  if (o.settings) await settings.update(o.settings);
  const mute = new MuteStore(kv);
  const db = new Database(":memory:");
  const speechLog = new SpeechLogStore({
    db: () => db,
    migrate: (d, stmts) => { for (const sql of stmts) d.exec(sql); },
    limits: () => settings.get().retention,
  });
  speechLog.init();
  const main = o.main ?? fakeEngine(LOCAL);
  const backup = o.backup ?? null;
  const chain = new EngineChain({ engines: () => ({ main, backup }) });
  const fetches: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fetches.push({ method, url, body });
    if (o.local === null) throw new TypeError("fetch failed");
    if (method === "PATCH" && o.hangPatch) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (method === "PATCH" && o.patchReply) return o.patchReply(body);
    const local = o.local ?? LOCAL_CONFIG;
    const config = method === "PATCH" ? { ...local, config: { ...local.config, ...(body as object) } } : local;
    return Response.json(config);
  };
  const stops: (string | null)[] = [];
  const spoken: unknown[][] = [];
  const sounds: unknown[][] = [];
  const published: [string, unknown][] = [];
  const replays: [string, string][] = [];
  const scopes = new VoiceScopes(kv);
  await scopes.load();
  scopes.onChange((kind) => { if (kind === "settings") published.push(["kokoro-scopes", { changed: true }]); });
  const scope = new LoadScope();
  const uvEvents: string[] = [];
  const supervisor = {
    status: () => ({ state: "needs-uv" as const, detail: null, progress: null, fixCommand: null, headless: null, gpuAvailable: false }),
    uvInstalled: () => { uvEvents.push("installed"); },
    uvInstallFailed: (message: string) => { uvEvents.push(`failed: ${message}`); },
  };
  registerRpc(host.bb, {
    settings,
    mute,
    speechLog,
    chain,
    engines: () => {
      const s = settings.get();
      return { main, backup, mainRef: s.engines.main, backupRef: s.engines.backup };
    },
    localUrl: () => LOCAL,
    fetch: fetchImpl,
    scope,
    turns: { replay: o.replay ?? (async (threadId, text) => { replays.push([threadId, text]); return { status: "playing" as const }; }) },
    supervisor: () => (o.installUv ? supervisor : null),
    installUv: o.installUv,
    prefs: new PrefsStore(kv),
    hub: {
      clients: () => [],
      stop: (sessionId) => { stops.push(sessionId); },
      stopAll: () => { stops.push(null); return 3; },
      speak: (...a) => { spoken.push(a); },
      sound: (...a) => { sounds.push(a); },
      hasReadyClient: () => o.ready ?? true,
    },
    log: host.bb.log,
    publish: (c, p) => { published.push([c, p]); },
    scopes,
    threadParent: o.threadParent ?? (async () => null),
    threadExists: o.threadExists ?? (async () => true),
    kv,
  });
  const call = <T>(name: string, input: unknown = null) => host.harness.callRpc(name, input) as Promise<T>;
  return { host, kv, settings, mute, speechLog, chain, fetches, stops, spoken, sounds, published, replays, scopes, call, db, uvEvents, scope };
}

test("getConfig answers with runtime: null when the local server is down", async () => {
  const h = await harness({ local: null });
  const r = await h.call<ConfigResponse>("getConfig");
  assert.equal(r.runtime, null);
  assert.equal(r.config.mode, "brief");
  assert.equal(r.muted, false);
  assert.equal(r.note, null);
  assert.equal(typeof r.pause_other_audio_supported, "boolean");
});

test("getConfig maps the local runtime and shows a remote provider as cpu", async () => {
  const h = await harness();
  const r = await h.call<ConfigResponse>("getConfig");
  assert.deepEqual(r.runtime, {
    config: { provider: "cpu", idle_unload_minutes: 10, intra_op_threads: 0, gpu_mem_limit_mb: 0 },
    providers_available: LOCAL_CONFIG.providers_available,
    restart_required: LOCAL_CONFIG.restart_required,
    restart_command: LOCAL_CONFIG.restart_command,
  });
  assert.deepEqual(h.fetches.map((f) => `${f.method} ${f.url}`), [`GET ${LOCAL}/config`]);
});

test("getConfig skips the local runtime when no slot uses the local engine", async () => {
  const h = await harness({ settings: { engines: { main: { url: "http://gpu:6789" }, backup: null } } });
  const r = await h.call<ConfigResponse>("getConfig");
  assert.equal(r.runtime, null);
  assert.deepEqual(h.fetches, []);
});

test("getConfig reports the migration note until it is dismissed", async () => {
  const h = await harness({ local: null });
  await h.kv.set("migration-note", "Speech now always plays in a bb window.");
  assert.equal((await h.call<ConfigResponse>("getConfig")).note, "Speech now always plays in a bb window.");
  assert.deepEqual(await h.call("dismissNote"), { ok: true });
  assert.equal(await h.kv.get("migration-note"), undefined);
  assert.equal((await h.call<ConfigResponse>("getConfig")).note, null);
});

test("a mixed patch is rejected and nothing changes", async () => {
  const h = await harness();
  await assert.rejects(h.call("patchConfig", { speed: 1.5, provider: "cuda" }));
  assert.equal(h.settings.get().speed, 1);
  assert.equal(h.fetches.some((f) => f.method === "PATCH"), false);
  assert.equal(h.published.length, 0);
});

test("a coordinator patch persists to kv and publishes the new config", async () => {
  const h = await harness({ local: null });
  const r = await h.call<ConfigResponse>("patchConfig", { speed: 1.2, retention: { maxAgeDays: 30, maxEntries: 500 } });
  assert.equal(r.config.speed, 1.2);
  assert.equal((await h.kv.get<Settings>("settings"))?.speed, 1.2);
  assert.deepEqual((await h.kv.get<Settings>("settings"))?.retention, { maxAgeDays: 30, maxEntries: 500 });
  assert.equal(h.fetches.some((f) => f.method === "PATCH"), false);
  assert.deepEqual(h.published, [["kokoro-config", r]]);
});

test("an invalid coordinator patch is rejected", async () => {
  const h = await harness({ local: null });
  await assert.rejects(h.call("patchConfig", { speed: 9 }));
  assert.equal(h.settings.get().speed, 1);
});

test("an empty patch changes nothing and answers the current config", async () => {
  const h = await harness({ local: null });
  const r = await h.call<ConfigResponse>("patchConfig", {});
  assert.equal(r.config.speed, 1);
  assert.equal(await h.kv.get("settings"), undefined, "nothing written");
});

test("a runtime patch goes to PATCH /config on the local server", async () => {
  const h = await harness();
  const r = await h.call<ConfigResponse>("patchConfig", { provider: "cuda", intra_op_threads: 4 });
  const patch = h.fetches.find((f) => f.method === "PATCH");
  assert.deepEqual(patch, { method: "PATCH", url: `${LOCAL}/config`, body: { provider: "cuda", intra_op_threads: 4 } });
  assert.equal(r.runtime?.config.provider, "cuda");
  assert.equal(r.runtime?.config.intra_op_threads, 4);
  assert.equal(await h.kv.get("settings"), undefined, "settings untouched");
  assert.deepEqual(h.published, [["kokoro-config", r]]);
});

test("a runtime patch the server refuses surfaces the server's message", async () => {
  const h = await harness({
    patchReply: () => Response.json({ error: "CUDA is not available on this machine" }, { status: 409 }),
  });
  await assert.rejects(h.call("patchConfig", { provider: "cuda" }), /CUDA is not available/);
  assert.equal(h.published.length, 0);
});

test("status reports each engine's health and breaker, the main's health, mute and latency", async () => {
  const main = fakeEngine("http://gpu:6789", { health: DOWN });
  const backup = fakeEngine(LOCAL, { health: { ...UP, loaded: false } });
  const h = await harness({ main, backup, settings: { engines: { main: { url: "http://gpu:6789" }, backup: "local" } } });
  const e = h.speechLog.add("Hi.", "t1", null);
  h.speechLog.setStatus(e.id, "done", { first_audio_ms: 420 });
  await h.mute.set(true);
  const s = await h.call<KokoroStatus>("status");
  assert.deepEqual(s.health, { up: false, error: "ECONNREFUSED" });
  assert.deepEqual(s.engines, [
    { slot: "main", url: "http://gpu:6789", local: false, health: { up: false, error: "ECONNREFUSED" }, breaker: "closed" },
    {
      slot: "backup", url: LOCAL, local: true, breaker: "closed",
      health: { up: true, health: { status: "ok", version: "0.3.4", model: "", active_sessions: 0 } },
    },
  ]);
  assert.equal(s.setup.state, "error", "no supervisor in this harness");
  assert.deepEqual(s.clients, []);
  assert.equal(s.muted, true);
  assert.deepEqual(s.latency, { median_ms: 420, samples: 1 });
});

test("status tells the chain each engine's health (a cold engine gets the long first-frame budget)", async () => {
  const main = fakeEngine(LOCAL, { health: { ...UP, loaded: false } });
  const h = await harness({ main });
  const noted: unknown[] = [];
  h.chain.noteHealth = (slot, health) => { noted.push([slot, health.loaded]); };
  await h.call("status");
  assert.deepEqual(noted, [["main", false]]);
});

test("status shows the main breaker open after main was unreachable", async () => {
  const h = await harness();
  const broken: Engine = {
    ...fakeEngine(LOCAL),
    synthesize: async function* () { throw new EngineError("unreachable", "unreachable: down"); },
  };
  const chain = new EngineChain({ engines: () => ({ main: broken, backup: null }) });
  await assert.rejects(async () => { for await (const _ of chain.synthesize("Hi.", {
    voice: "af_sky", speed: 1, lang: "en-us", trim: true, leadInMs: 0, gapMs: 0,
  }, new AbortController().signal)); });
  h.chain.breaker = () => chain.breaker();
  const s = await h.call<KokoroStatus>("status");
  assert.equal(s.engines[0]!.breaker, "open");
});

test("listVoices comes from main, else backup; both down throws", async () => {
  const other: VoiceInfo[] = [{ ...VOICES[0]!, name: "bm_george" }];
  let h = await harness({ main: fakeEngine(LOCAL), backup: fakeEngine("http://b", { voices: other }) });
  assert.deepEqual(await h.call("listVoices"), { voices: VOICES });
  h = await harness({ main: fakeEngine(LOCAL, { voices: new Error("down") }), backup: fakeEngine("http://b", { voices: other }) });
  assert.deepEqual(await h.call("listVoices"), { voices: other });
  h = await harness({ main: fakeEngine(LOCAL, { voices: new Error("main down") }), backup: fakeEngine("http://b", { voices: new Error("b down") }) });
  await assert.rejects(h.call("listVoices"));
  h = await harness({ main: fakeEngine(LOCAL, { voices: new Error("main down") }) });
  await assert.rejects(h.call("listVoices"), /main down/);
});

test("preview plays on the main engine by default, with the configured gain", async () => {
  const h = await harness({ settings: { speech_gain: 0.8 } });
  assert.deepEqual(await h.call("preview", { voice: "af_bella", speed: 1.2 }), { status: "playing" });
  const [entryId, text, session, gain, opts] = h.spoken[0] as [number, string, string, number, Record<string, unknown>];
  assert.ok(entryId >= 0xf000_0000);
  assert.equal(text, "This is how I will sound when reading your updates.");
  assert.equal(session, "preview");
  assert.equal(gain, 0.8);
  assert.deepEqual(opts, { voice: "af_bella", speed: 1.2, lang: undefined, slot: "main" });
});

test("preview can pick the backup slot and its own text and gain", async () => {
  const h = await harness();
  await h.call("preview", { text: "  Hello  ", speech_gain: 1.5, slot: "backup" });
  const [, text, , gain, opts] = h.spoken[0] as [number, string, string, number, { slot: string }];
  assert.deepEqual([text, gain, opts.slot], ["Hello", 1.5, "backup"]);
});

test("preview and sound tests report no_window when no window can play", async () => {
  const h = await harness({ ready: false });
  assert.deepEqual(await h.call("preview", {}), { status: "no_window" });
  assert.deepEqual(await h.call("playSound", { sound: "done" }), { status: "no_window" });
  assert.deepEqual([h.spoken, h.sounds], [[], []]);
});

test("sound tests play at the configured cue volume", async () => {
  const h = await harness({ settings: { sound_volume: 0.6 } });
  assert.deepEqual(await h.call("playSound", { sound: "done" }), { status: "playing" });
  assert.deepEqual(h.sounds, [["done", 0.6, "bb-preview"]]);
});

test("replay hands an existing thread's text to the coordinator", async () => {
  const h = await harness();
  assert.deepEqual(await h.call("replay", { threadId: "t1", text: "Again." }), { status: "playing" });
  assert.deepEqual(h.replays, [["t1", "Again."]]);
});

test("replay of a deleted thread is unsupported and logs nothing", async () => {
  const h = await harness({ threadExists: async () => false });
  assert.deepEqual(await h.call("replay", { threadId: "gone", text: "Again." }), { status: "unsupported" });
  assert.deepEqual(h.replays, []);
});

test("replay surfaces a coordinator failure as an RPC error", async () => {
  const h = await harness({ replay: async () => { throw new Error("hub down"); } });
  await assert.rejects(h.call("replay", { threadId: "t1", text: "Again." }), /hub down/);
});

test("mute stops all playback, persists, and publishes; unmute does not stop", async () => {
  const h = await harness({ local: null });
  assert.deepEqual(await h.call("setMuted", { muted: true }), { muted: true });
  assert.deepEqual(h.stops, [null]);
  assert.equal(await h.kv.get("muted"), true);
  const [channel, payload] = h.published.at(-1)!;
  assert.equal(channel, "kokoro-config");
  assert.equal((payload as ConfigResponse).muted, true);
  await h.call("setMuted", { muted: false });
  assert.deepEqual(h.stops, [null]);
  assert.equal(h.mute.get(), false);
});

test("Stop all counts the replies it stopped", async () => {
  const h = await harness();
  assert.deepEqual(await h.call("interruptAll"), { sessions_cancelled: 3 });
});

test("Stop on a card stops only that thread", async () => {
  const h = await harness();
  assert.deepEqual(await h.call("stop", { threadId: "t1" }), { status: "stopped" });
  assert.deepEqual(h.stops, ["t1"]);
});

test("the speech log is listed per thread from the store", async () => {
  const h = await harness();
  h.speechLog.add("One.", "t 1", "af_sky");
  h.speechLog.add("Other.", "t2", null);
  const r = await h.call<{ entries: { text: string; session_id: string }[] }>("speechLog", { threadId: "t 1" });
  assert.deepEqual(r.entries.map((e) => [e.session_id, e.text]), [["t 1", "One."]]);
});

test("clearHistory deletes every row and publishes kokoro-log-cleared", async () => {
  const h = await harness();
  h.speechLog.add("One.", "t1", null);
  h.speechLog.add("Two.", "t2", null);
  assert.deepEqual(await h.call("clearHistory"), { deleted: 2 });
  assert.equal(h.speechLog.count(), 0);
  assert.deepEqual(h.published, [["kokoro-log-cleared", {}]]);
});

test("a rejecting uv installer is reported as a failed install, not left unhandled", async () => {
  const h = await harness({ installUv: async () => { throw new Error("spawn sh ENOENT"); } });
  assert.deepEqual(await h.call("installUv"), { started: true });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.uvEvents, ["failed: spawn sh ENOENT"]);
  assert.ok(h.host.harness.inspection.logEntries.some((e) => e.level === "warn" && /spawn sh ENOENT/.test(e.message)));
  assert.deepEqual(await h.call("installUv"), { started: true }, "a later click can try again");
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

// callRpc returns Promise<unknown>; tsc checks test files.
type H = Awaited<ReturnType<typeof harness>>;
const scopeRpc = (h: H, name: "getVoiceScope" | "setVoiceScope", input: unknown) => h.call<VoiceScopeState>(name, input);

test("getVoiceScope looks an unknown parent up once and reports inherited and effective voice", async () => {
  const parentCalls: string[] = [];
  const h = await harness({ threadParent: async (id) => { parentCalls.push(id); return "t0"; } });
  await h.scopes.set("thread", "t0", { mode: "verbose", voiceChildren: true });
  const r = await scopeRpc(h, "getVoiceScope", { threadId: "c1", projectId: "p1" });
  assert.equal(r.parentThreadId, "t0");
  assert.deepEqual([r.effective.mode, r.effective.voiced, r.effective.modeFrom], ["verbose", true, "parent"]);
  await scopeRpc(h, "getVoiceScope", { threadId: "c1", projectId: "p1" });
  assert.deepEqual(parentCalls, ["c1"]);
});

test("a failed parent lookup resolves as a root and is retried next time", async () => {
  let n = 0;
  const h = await harness({ threadParent: async () => { n++; throw new Error("down"); } });
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
  const h = await harness({ threadParent: async () => { n++; return null; } });
  await scopeRpc(h, "getVoiceScope", { threadId: "t1", projectId: "p1" });
  await scopeRpc(h, "getVoiceScope", { threadId: "t1", projectId: "p1" });
  assert.equal(n, 1);
});

test("setVoiceScope writes the right scope, null clears, inherited ignores the thread's own mode, and publishes", async () => {
  const h = await harness();
  let r = await scopeRpc(h, "setVoiceScope", { threadId: "t1", projectId: "p1", scope: "project", patch: { mode: "quiet" } });
  assert.deepEqual([r.project, r.effective.voiced], [{ mode: "quiet" }, false]);
  r = await scopeRpc(h, "setVoiceScope", { threadId: "t1", projectId: "p1", scope: "thread", patch: { mode: "brief" } });
  assert.deepEqual([r.thread, r.effective.voiced, r.effective.modeFrom, r.inherited.mode, r.inherited.modeFrom],
    [{ mode: "brief" }, true, "thread", "quiet", "project"]);
  r = await scopeRpc(h, "setVoiceScope", { threadId: "t1", projectId: "p1", scope: "thread", patch: { mode: null } });
  assert.deepEqual(r.thread, {});
  assert.ok(h.published.some(([c]) => c === "kokoro-scopes"));
});

test("getVoiceScope reads the global mode from the plugin's settings", async () => {
  const h = await harness({ settings: { mode: "verbose" } });
  const r = await scopeRpc(h, "getVoiceScope", { threadId: "t1", projectId: "p1" });
  assert.equal(r.globalMode, "verbose");
  assert.equal(r.effective.mode, "verbose");
  assert.deepEqual(h.fetches, [], "never calls a server");
});

test("disposing the load scope aborts an in-flight runtime PATCH at once", async () => {
  const h = await harness({ hangPatch: true });
  const pending = h.call("patchConfig", { provider: "cpu" });
  pending.catch(() => undefined);
  for (let i = 0; i < 50 && !h.fetches.some((f) => f.method === "PATCH"); i++) await new Promise((r) => setImmediate(r));
  const t0 = Date.now();
  await h.scope.dispose(10_000);
  assert.ok(Date.now() - t0 < 1_000, "dispose did not wait for the 30 s PATCH timeout");
  await assert.rejects(pending, /cancelled/);
});
