import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { TurnCoordinator } from "./coord/turns.ts";
import { DEFAULT_SETTINGS, type Mode } from "./schemas.ts";
import { VoiceScopes, type ScopesData } from "./scopes.ts";
import { registerVoice } from "./voice.ts";

interface Options {
  ready?: boolean;
  /** The global mode in settings. */
  mode?: Mode;
  /** Voice settings to seed before registering. */
  scopes?: Partial<ScopesData>;
  /** Make kv writes to this key fail. */
  failKv?: string;
  /** Threads the fake coordinator reports as having spoken. */
  spoken?: string[];
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
  const calls: unknown[][] = [];
  const published: unknown[] = [];
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
  const spoken = new Set(o.spoken ?? []);
  const turns = {
    idle: async (...a: unknown[]) => { calls.push(["idle", ...a]); },
    attention: async (...a: unknown[]) => { calls.push(["attention", ...a]); },
    interrupt: async (...a: unknown[]) => { calls.push(["interrupt", ...a]); },
    archived: async (...a: unknown[]) => { calls.push(["archived", ...a]); },
    deleted: async (...a: unknown[]) => { calls.push(["deleted", ...a]); },
    hasSpoken: (id: string) => spoken.has(id),
  } as unknown as TurnCoordinator;
  const host = createFakePluginHost();
  hosts.push(host);
  registerVoice(host.bb, {
    turns,
    scopes,
    hub: { hasReadyClient: () => o.ready ?? true },
    settings: () => ({ ...DEFAULT_SETTINGS, mode: o.mode ?? "brief" }),
    publish: (channel, payload) => { published.push([channel, payload]); },
    contract: "Mode: {{MODE}}.",
    contractFull: "Full: {{MODE}}, no blocks.",
  });
  const instructions = (threadId = "t1", projectId = "p1") =>
    host.harness.registrations.instructionProvider?.({ threadId, projectId });
  return { host, calls, published, instructions, scopes };
}

const root = (id = "t1") => makeThreadResponse({ id, parentThreadId: null, projectId: "p1" });
const kid = (id: string, parent: string) => makeThreadResponse({ id, parentThreadId: parent, projectId: "p1" });
const child = () => kid("c1", "t1");
const tick = () => new Promise((r) => setImmediate(r));

test("thread.idle hands a voiced turn to the coordinator with its mode", async () => {
  const { host, calls, published } = await harness({ mode: "verbose" });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.deepEqual(calls, [["idle", "t1", "Done.", "verbose"]]);
  assert.deepEqual(published, []);
});

test("thread.idle uses an override's mode", async () => {
  const { host, calls } = await harness({ scopes: { threads: { t1: { mode: "ambient" } } } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.deepEqual(calls, [["idle", "t1", "Done.", "ambient"]]);
});

test("thread.idle with no text does nothing", async () => {
  for (const lastAssistantText of ["  ", null]) {
    const { host, calls, published } = await harness();
    await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText });
    assert.deepEqual([calls, published], [[], []]);
  }
});

test("thread.idle for an unvoiced child only tells its cards it is off", async () => {
  const { host, calls, published } = await harness();
  await host.harness.emitThreadEvent("thread.idle", { thread: child(), lastAssistantText: "Child done." });
  assert.deepEqual(calls, []);
  assert.deepEqual(published, [["kokoro-turn", { threadId: "c1", action: "off" }]]);
});

test("an off thread's reply publishes off", async () => {
  const { host, calls, published } = await harness({ scopes: { projects: { p1: { mode: "quiet" } } } });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.deepEqual(calls, []);
  assert.deepEqual(published, [["kokoro-turn", { threadId: "t1", action: "off" }]]);
});

test("global quiet: thread.idle reaches no coordinator", async () => {
  const { host, calls } = await harness({ mode: "quiet" });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.deepEqual(calls, []);
});

test("no ready window stays quiet", async () => {
  const { host, calls, published } = await harness({ ready: false });
  await host.harness.emitThreadEvent("thread.idle", { thread: root(), lastAssistantText: "Done." });
  assert.deepEqual([calls, published], [[], []]);
});

test("instructions carry the contract with the settings mode", async () => {
  assert.equal((await harness({ mode: "verbose" })).instructions(), "Mode: verbose.");
  assert.equal((await harness()).instructions(), "Mode: brief.");
});

test("full mode swaps in the short contract without directives", async () => {
  assert.equal((await harness({ mode: "full" })).instructions(), "Full: full, no blocks.");
});

test("instructions are null for an off thread and use the thread's mode otherwise", async () => {
  const { instructions } = await harness({ scopes: { threads: { t1: { mode: "quiet" }, t2: { mode: "verbose" } } } });
  assert.equal(instructions("t1"), null);
  assert.equal(instructions("t2"), "Mode: verbose.");
});

test("a thread on Full gets the full contract; global quiet gives no contract", async () => {
  assert.equal((await harness({ scopes: { threads: { t1: { mode: "full" } } } })).instructions(), "Full: full, no blocks.");
  assert.equal((await harness({ mode: "quiet" })).instructions(), null);
});

test("thread.active and thread.failed interrupt the thread", async () => {
  const { host, calls } = await harness();
  await host.harness.emitThreadEvent("thread.active", { thread: root() });
  await host.harness.emitThreadEvent("thread.failed", { thread: root(), error: "boom" });
  assert.deepEqual(calls, [["interrupt", "t1"], ["interrupt", "t1"]]);
});

test("thread.active stops a root thread even when it is off", async () => {
  const { host, calls } = await harness({ scopes: { threads: { t1: { mode: "quiet" } } } });
  await host.harness.emitThreadEvent("thread.active", { thread: root() });
  assert.deepEqual(calls, [["interrupt", "t1"]]);
});

test("thread.active, failed, archive and delete ignore unvoiced children that never spoke", async () => {
  const { host, calls } = await harness();
  await host.harness.emitThreadEvent("thread.active", { thread: child() });
  await host.harness.emitThreadEvent("thread.failed", { thread: child(), error: null });
  await host.harness.emitThreadEvent("thread.archived", { thread: child() });
  await host.harness.emitThreadEvent("thread.deleted", { thread: child() });
  assert.deepEqual(calls, []);
});

test("a child switched off after it spoke still stops", async () => {
  const { host, calls } = await harness({ spoken: ["c1"] });
  await host.harness.emitThreadEvent("thread.active", { thread: child() });
  assert.deepEqual(calls, [["interrupt", "c1"]]);
});

test("a child is voiced when its parent voices children, with the parent's mode", async () => {
  const { host, calls } = await harness({ scopes: { threads: { t1: { mode: "conversational", voiceChildren: true } } } });
  await host.harness.emitThreadEvent("thread.idle", { thread: child(), lastAssistantText: "Done." });
  assert.deepEqual(calls, [["idle", "c1", "Done.", "conversational"]]);
});

test("a failed parent write keeps a child unvoiced", async () => {
  const { host, calls } = await harness({ failKv: "voice-parents" });
  await host.harness.emitThreadEvent("thread.idle", { thread: child(), lastAssistantText: "Done." });
  assert.deepEqual(calls, []);
});

test("interaction.pending hands voiced threads to the coordinator and skips off ones", async () => {
  const on = await harness({ scopes: { threads: { t1: { mode: "ambient" } } } });
  await on.host.harness.emitThreadEvent("interaction.pending", { thread: root(), interaction: {} as never });
  assert.deepEqual(on.calls, [["attention", "t1", "ambient"]]);
  const off = await harness({ scopes: { threads: { t1: { mode: "quiet" } } } });
  await off.host.harness.emitThreadEvent("interaction.pending", { thread: root(), interaction: {} as never });
  assert.deepEqual(off.calls, []);
});

test("archive and delete reach the coordinator", async () => {
  const { host, calls } = await harness();
  await host.harness.emitThreadEvent("thread.archived", { thread: root() });
  await host.harness.emitThreadEvent("thread.deleted", { thread: root() });
  assert.deepEqual(calls, [["archived", "t1"], ["deleted", "t1"]]);
});

test("delete forgets the thread's scopes before telling the coordinator", async () => {
  const a = await harness({ scopes: { threads: { c1: { voiceChildren: false } }, parents: { c1: "t1" } } });
  await a.host.harness.emitThreadEvent("thread.deleted", { thread: kid("c1", "t1") });
  assert.deepEqual([a.scopes.parentOf("c1"), "c1" in a.scopes.get().threads], [undefined, false]);
  const b = await harness({ scopes: { threads: { t1: { mode: "brief" } } } });
  await b.host.harness.emitThreadEvent("thread.deleted", { thread: root() });
  assert.equal("t1" in b.scopes.get().threads, false);
  assert.deepEqual(b.calls, [["deleted", "t1"]]);
});

test("a child voiced by its own mode is still cleaned up when deleted", async () => {
  const { host, calls } = await harness({ scopes: { threads: { c1: { mode: "brief" } }, parents: { c1: "t1" } } });
  await host.harness.emitThreadEvent("thread.deleted", { thread: kid("c1", "t1") });
  assert.deepEqual(calls, [["deleted", "c1"]]);
});

test("thread.created learns the parent", async () => {
  const { host, scopes } = await harness();
  await host.harness.emitThreadEvent("thread.created", { thread: kid("c9", "t1") });
  await tick();
  assert.equal(scopes.parentOf("c9"), "t1");
});
