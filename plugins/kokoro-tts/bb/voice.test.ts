import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { KokoroClient } from "./kokoro-client.ts";
import { CONFIG_RESPONSE } from "./page/fixtures.ts";
import { DEFAULT_PREFS } from "./prefs.ts";
import type { ConfigResponse, KokoroConfig, Prefs } from "./schemas.ts";
import { VoiceScopes, type ScopesData } from "./scopes.ts";
import { registerVoice } from "./voice.ts";

interface Options {
  prefs?: Partial<Prefs>;
  replies?: Record<string, unknown>;
  ready?: boolean;
  /** The cached server config; null when none has been fetched yet. */
  config?: (Partial<KokoroConfig> & { muted?: boolean }) | null;
  /** What a fresh fetch returns, when it differs from the cache. */
  fetched?: Partial<KokoroConfig> & { muted?: boolean };
  /** Hold each /turn's reply until released, in call order. */
  gates?: Promise<void>[];
  /** Voice settings to seed before registering. */
  scopes?: Partial<ScopesData>;
  /** Make kv writes to this key fail. */
  failKv?: string;
  /** Paths whose call rejects. */
  fail?: string[];
}

// Every host a test makes is disposed after it, pass or fail.
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

async function seed(s: VoiceScopes, d: Partial<ScopesData>) {
  for (const [id, v] of Object.entries(d.threads ?? {})) await s.set("thread", id, v);
  for (const [id, v] of Object.entries(d.projects ?? {})) await s.set("project", id, v);
  for (const [id, p] of Object.entries(d.parents ?? {})) await s.learnParent(id, p);
}

async function harness(o: Options = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const hubCalls: unknown[][] = [];
  const client: KokoroClient = {
    baseUrl: "http://127.0.0.1:6789",
    async call<T>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (o.fail?.includes(path)) throw new Error("down");
      if (path === "/turn") await o.gates?.shift();
      return (o.replies?.[path] ?? { action: "silent" }) as T;
    },
    async *synthesize() {},
  };
  const response = ({ muted = false, ...cfg }: Partial<KokoroConfig> & { muted?: boolean }): ConfigResponse =>
    ({ ...CONFIG_RESPONSE, muted, config: { ...CONFIG_RESPONSE.config, ...cfg } });
  const config = o.config === null ? null : response(o.config ?? {});
  const fetched = o.fetched ? response(o.fetched) : config;
  const kv = new Map<string, unknown>();
  let failing = false;
  const scopes = new VoiceScopes({
    get: async <T>(k: string) => kv.get(k) as T | undefined,
    set: async (k, v) => {
      if (failing && k === o.failKv) throw new Error("kv down");
      kv.set(k, v);
    },
  });
  await scopes.load();
  await seed(scopes, o.scopes ?? {});
  failing = true;
  const host = createFakePluginHost();
  hosts.push(host);
  registerVoice(host.bb, {
    scopes,
    client: () => client,
    publish: (channel, payload) => { calls.push({ method: "PUBLISH", path: channel, body: payload }); },
    hub: {
      speak: (...a) => { hubCalls.push(["speak", ...a]); },
      sound: (...a) => { hubCalls.push(["sound", ...a]); },
      stop: (...a) => { hubCalls.push(["stop", ...a]); },
      hasReadyClient: () => o.ready ?? true,
    },
    prefs: { get: () => ({ ...DEFAULT_PREFS, ...o.prefs }) },
    config: {
      get: () => config,
      current: async () => {
        if (!fetched) throw new Error("server down");
        return fetched;
      },
    },
    contract: "Mode: {{MODE}}.",
    contractFull: "Full: {{MODE}}, no blocks.",
  });
  const instructions = (threadId = "t1", projectId = "p1") =>
    host.harness.registrations.instructionProvider?.({ threadId, projectId });
  return { host, calls, hubCalls, instructions, scopes };
}

const root = (id = "t1") => makeThreadResponse({ id, parentThreadId: null, projectId: "p1" });
const child = () => makeThreadResponse({ id: "c1", parentThreadId: "t1", projectId: "p1" });
const tick = () => new Promise((r) => setImmediate(r));

test("thread.idle in client mode routes speech to the hub", async () => {
  const { host, calls, hubCalls } = await harness({ replies: {
    "/turn": { action: "speech", text: "Done.", entry_id: 5, speech_gain: 0.8, logged_text: "Done." },
  } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.deepEqual(calls.find((c) => c.path === "/turn"), {
    method: "POST", path: "/turn", body: { text: "Done.", session_id: "t1", playback: "client" },
  });
  assert.deepEqual(hubCalls, [["speak", 5, "Done.", "t1", 0.8]]);
});

test("thread.idle tells cards a turn is out, then what it logged", async () => {
  const { host, calls } = await harness({ replies: {
    "/turn": { action: "speech", text: "Bold done.", entry_id: 5, logged_text: "**Bold** done." },
  } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "x" });
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ["PUBLISH", "kokoro-turn", { threadId: "t1", pending: true }],
    ["POST", "/turn", { text: "x", session_id: "t1", playback: "client" }],
    ["PUBLISH", "kokoro-turn", { threadId: "t1", action: "speech", text: "**Bold** done." }],
  ]);
});

test("a turn that logs nothing still settles the cards' pending state", async () => {
  const { host, calls } = await harness({ replies: { "/turn": { action: "silent" } } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "x" });
  assert.deepEqual(calls.at(-1), { method: "PUBLISH", path: "kokoro-turn", body: { threadId: "t1", action: "silent" } });
});

test("thread.idle in server mode lets the server play", async () => {
  const { host, calls, hubCalls } = await harness({ prefs: { playback: "server" }, replies: { "/turn": { action: "speech", text: "Done." } } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.equal((calls.find((c) => c.path === "/turn")?.body as { playback: string }).playback, "server");
  assert.deepEqual(hubCalls, []);
});

test("thread.idle for an unvoiced child only tells its cards it is off", async () => {
  const { host, calls } = await harness();
  await host.harness.emitThreadEvent("thread.idle", { thread: child(), lastAssistantText: "Child done." });
  assert.deepEqual(calls, [{ method: "PUBLISH", path: "kokoro-turn", body: { threadId: "c1", action: "off" } }]);
});

test("client mode with no ready window stays quiet", async () => {
  const { host, calls } = await harness({ ready: false });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.deepEqual(calls, []);
});

test("thread.idle with no text does nothing", async () => {
  const { host, calls } = await harness();
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "  " });
  assert.deepEqual(calls, []);
});

test("instructions carry the contract with the cached mode", async () => {
  assert.equal((await harness({ config: { mode: "verbose" } })).instructions(), "Mode: verbose.");
  assert.equal((await harness({ config: null })).instructions(), "Mode: brief.", "no config seen yet");
});

test("full mode swaps in the short contract without directives", async () => {
  assert.equal((await harness({ config: { mode: "full" } })).instructions(), "Full: full, no blocks.");
});

test("sound results go to the hub with volume", async () => {
  const { host, hubCalls } = await harness({ replies: { "/turn": { action: "sound", sound: "done", sound_volume: 0.4 } } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "x" });
  assert.deepEqual(hubCalls, [["sound", "done", 0.4, "t1"]]);
});

test("malformed server replies are ignored", async () => {
  const { host, hubCalls } = await harness({ replies: { "/turn": { action: "yell" } } });
  const { errors } = await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "x" });
  assert.deepEqual(errors, []);
  assert.deepEqual(hubCalls, []);
});

test("thread.active stops client playback", async () => {
  const { host, hubCalls, calls } = await harness();
  await host.harness.emitThreadEvent("thread.active", { thread: root() });
  assert.deepEqual(hubCalls, [["stop", "t1"]]);
  assert.deepEqual(calls, []);
});

test("thread.active interrupts server playback", async () => {
  const { host, calls } = await harness({ prefs: { playback: "server" } });
  await host.harness.emitThreadEvent("thread.active", { thread: root() });
  assert.deepEqual(calls, [{ method: "POST", path: "/interrupt", body: { session_id: "t1" } }]);
});

test("thread.active, archive and delete ignore child threads", async () => {
  for (const playback of ["client", "server"] as const) {
    const { host, calls, hubCalls } = await harness({ prefs: { playback } });
    await host.harness.emitThreadEvent("thread.active", { thread: child() });
    await host.harness.emitThreadEvent("thread.archived", { thread: child() });
    await host.harness.emitThreadEvent("thread.deleted", { thread: child() });
    assert.deepEqual([calls, hubCalls], [[], []], playback);
  }
});

async function activeDuringTurn(playback: "client" | "server") {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = await harness({ prefs: { playback }, gates: [gate], replies: {
    "/turn": { action: "speech", text: "Done.", entry_id: 5, logged_text: "Done." },
  } });
  const idle = h.host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  await tick();
  await h.host.harness.emitThreadEvent("thread.active", { thread: root() });
  release();
  await idle;
  return h;
}

test("a thread going active while its /turn is out drops the browser reply", async () => {
  const { calls, hubCalls } = await activeDuringTurn("client");
  assert.deepEqual(hubCalls, [["stop", "t1"]], "no speak after the stop");
  assert.deepEqual(calls.find((c) => c.path === "/speech-log/status")?.body, { id: 5, status: "interrupted" });
  assert.deepEqual(calls.at(-1)?.body, { threadId: "t1", action: "speech", text: "Done." });
});

test("a thread going active while its /turn is out interrupts the server again", async () => {
  const { calls } = await activeDuringTurn("server");
  assert.deepEqual(calls.filter((c) => c.path === "/interrupt").length, 2);
  const turn = calls.findIndex((c) => c.path === "/turn");
  assert.ok(calls.map((c) => c.path).lastIndexOf("/interrupt") > turn);
});

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release };
}

test("a cancelled turn that returns after a newer one leaves the newer server playback alone", async () => {
  for (const newerDone of [true, false]) {
    const first = gated();
    const second = gated();
    if (newerDone) second.release();
    const { host, calls } = await harness({ prefs: { playback: "server" }, gates: [first.gate, second.gate], replies: {
      "/turn": { action: "speech", logged_text: "Done." },
    } });
    const idle1 = host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "First." });
    await tick();
    await host.harness.emitThreadEvent("thread.active", { thread: root() });
    const idle2 = host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Second." });
    await tick();
    first.release();
    await idle1;
    second.release();
    await idle2;
    assert.equal(calls.filter((c) => c.path === "/interrupt").length, 1, `only thread.active's (newer done: ${newerDone})`);
  }
});

test("a turn the server did not speak tells cards its say and whether mute silenced it", async () => {
  const { host, calls } = await harness({ replies: { "/turn": { action: "silent", muted: true, say_text: "All done." } } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "x" });
  assert.deepEqual(calls.at(-1)?.body, { threadId: "t1", action: "silent", say: "All done.", muted: true });
});

test("a later turn in the thread is not affected by an earlier cancelled one", async () => {
  const h = await activeDuringTurn("client");
  await h.host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Again." });
  assert.deepEqual(h.hubCalls.at(-1), ["speak", 5, "Done.", "t1", 1]);
});

test("interaction.pending in client playback plays the ping without asking the server", async () => {
  const { host, calls, hubCalls } = await harness({ config: { sound_volume: 0.6 } });
  await host.harness.emitThreadEvent("interaction.pending", { thread: root(), interaction: {} as never });
  assert.deepEqual(calls, []);
  assert.deepEqual(hubCalls, [["sound", "attention", 0.6, "t1"]]);
});

test("interaction.pending in client playback stays quiet when muted, in quiet mode, or with the ping off", async () => {
  for (const config of [{ muted: true }, { mode: "quiet" as const }, { attention_sound: false }, null]) {
    const { host, hubCalls } = await harness({ config });
    await host.harness.emitThreadEvent("interaction.pending", { thread: root(), interaction: {} as never });
    assert.deepEqual(hubCalls, [], JSON.stringify(config));
  }
});

test("interaction.pending in client playback stays quiet when the cache is empty and the fetch says quiet", async () => {
  const { host, hubCalls } = await harness({ config: null, fetched: { mode: "quiet" } });
  await host.harness.emitThreadEvent("interaction.pending", { thread: root(), interaction: {} as never });
  assert.deepEqual(hubCalls, []);
});

test("interaction.pending in server playback cues the server", async () => {
  const { host, calls, hubCalls } = await harness({ prefs: { playback: "server" } });
  await host.harness.emitThreadEvent("interaction.pending", { thread: root(), interaction: {} as never });
  assert.deepEqual(calls, [{
    method: "POST", path: "/cue", body: { sound: "attention", session_id: "t1", playback: "server" },
  }]);
  assert.deepEqual(hubCalls, []);
});

test("archive stops and cleans up", async () => {
  const { host, calls, hubCalls } = await harness();
  await host.harness.emitThreadEvent("thread.archived", { thread: root() });
  assert.deepEqual(hubCalls, [["stop", "t1"]]);
  assert.deepEqual(calls, [{ method: "POST", path: "/cleanup", body: { session_id: "t1" } }]);
});

const kid = (id: string, parent: string) => makeThreadResponse({ id, parentThreadId: parent, projectId: "p1" });

test("instructions are null for an off thread and use the thread's mode otherwise", async () => {
  const { instructions } = await harness({ scopes: { threads: { t1: { mode: "quiet" }, t2: { mode: "verbose" } } } });
  assert.equal(instructions("t1"), null);
  assert.equal(instructions("t2"), "Mode: verbose.");
});

test("a thread on Full gets the full contract; global quiet gives no contract", async () => {
  assert.equal((await harness({ scopes: { threads: { t1: { mode: "full" } } } })).instructions(), "Full: full, no blocks.");
  assert.equal((await harness({ config: { mode: "quiet" } })).instructions(), null);
});

test("an off thread's reply makes no server call and publishes off", async () => {
  const { host, calls } = await harness({ scopes: { projects: { p1: { mode: "quiet" } } } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.deepEqual(calls, [{ method: "PUBLISH", path: "kokoro-turn", body: { threadId: "t1", action: "off" } }]);
});

test("global quiet: thread.idle makes no /turn call", async () => {
  const { host, calls } = await harness({ config: { mode: "quiet" } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.equal(calls.some((c) => c.path === "/turn"), false);
});

test("an override sends its mode; no mode without an override, even with an empty cache", async () => {
  const over = await harness({ scopes: { threads: { t1: { mode: "verbose" } } } });
  await over.host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.equal((over.calls.find((c) => c.path === "/turn")?.body as { mode?: string }).mode, "verbose");
  for (const config of [undefined, null] as const) {
    const plain = await harness({ config });
    await plain.host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
    assert.equal("mode" in (plain.calls.find((c) => c.path === "/turn")?.body as object), false, String(config));
  }
  const coldOverride = await harness({ config: null, scopes: { threads: { t1: { mode: "ambient" } } } });
  await coldOverride.host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.equal((coldOverride.calls.find((c) => c.path === "/turn")?.body as { mode?: string }).mode, "ambient");
});

test("a child is voiced when its parent voices children, with the parent's mode", async () => {
  const { host, calls } = await harness({ scopes: { threads: { t1: { mode: "conversational", voiceChildren: true } } } });
  await host.harness.emitThreadEvent("thread.idle", { thread: kid("c1", "t1"), lastAssistantText: "Done." });
  assert.equal((calls.find((c) => c.path === "/turn")?.body as { mode?: string }).mode, "conversational");
});

test("a failed parent write keeps a child unvoiced", async () => {
  const { host, calls } = await harness({ failKv: "voice-parents" });
  await host.harness.emitThreadEvent("thread.idle", { thread: kid("c1", "t1"), lastAssistantText: "Done." });
  assert.equal(calls.some((c) => c.path === "/turn"), false);
});

test("thread.active stops a root thread even when it is off", async () => {
  const { host, hubCalls } = await harness({ scopes: { threads: { t1: { mode: "quiet" } } } });
  await host.harness.emitThreadEvent("thread.active", { thread: root() });
  assert.deepEqual(hubCalls, [["stop", "t1"]]);
});

test("a child switched off mid-reply still stops", async () => {
  const { host, hubCalls, scopes } = await harness({
    scopes: { threads: { t1: { voiceChildren: true } } },
    replies: { "/turn": { action: "speech", text: "Hi.", entry_id: 1 } },
  });
  await host.harness.emitThreadEvent("thread.idle", { thread: kid("c1", "t1"), lastAssistantText: "Hi." });
  await scopes.set("thread", "t1", { voiceChildren: null });
  await host.harness.emitThreadEvent("thread.active", { thread: kid("c1", "t1") });
  assert.deepEqual(hubCalls.at(-1), ["stop", "c1"]);
});

test("interaction.pending uses an override's mode and skips off threads", async () => {
  const server = await harness({ prefs: { playback: "server" }, scopes: { threads: { t1: { mode: "ambient" } } } });
  await server.host.harness.emitThreadEvent("interaction.pending", { thread: root(), interaction: {} as never });
  assert.equal((server.calls[0]?.body as { mode?: string }).mode, "ambient");
  const off = await harness({ scopes: { threads: { t1: { mode: "quiet" } } } });
  await off.host.harness.emitThreadEvent("interaction.pending", { thread: root(), interaction: {} as never });
  assert.deepEqual([off.calls, off.hubCalls], [[], []]);
});

test("thread.created learns the parent", async () => {
  const { host, scopes } = await harness();
  await host.harness.emitThreadEvent("thread.created", { thread: kid("c9", "t1") });
  await tick();
  assert.equal(scopes.parentOf("c9"), "t1");
});

test("delete forgets an unvoiced child, and forgets even when /cleanup fails", async () => {
  const a = await harness({ scopes: { threads: { c1: { voiceChildren: false } }, parents: { c1: "t1" } } });
  await a.host.harness.emitThreadEvent("thread.deleted", { thread: kid("c1", "t1") });
  assert.deepEqual([a.scopes.parentOf("c1"), "c1" in a.scopes.get().threads], [undefined, false]);
  const b = await harness({ scopes: { threads: { t1: { mode: "brief" } } }, fail: ["/cleanup"] });
  await b.host.harness.emitThreadEvent("thread.deleted", { thread: root() });
  assert.equal("t1" in b.scopes.get().threads, false);
});
