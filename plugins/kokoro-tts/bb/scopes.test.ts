import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PARENTS, resolveVoice, VoiceScopes, type ScopesData } from "./scopes.ts";

const data = (o: Partial<ScopesData> = {}): ScopesData => ({ threads: {}, projects: {}, parents: {}, ...o });
function memKv(failOn?: string) {
  const m = new Map<string, unknown>();
  return {
    m,
    kv: {
      get: async <T>(k: string) => m.get(k) as T | undefined,
      set: async (k: string, v: unknown) => {
        if (k === failOn) throw new Error("kv full");
        m.set(k, structuredClone(v));
      },
    },
  };
}
async function store(failOn?: string) {
  const { m, kv } = memKv(failOn);
  const s = new VoiceScopes(kv);
  await s.load();
  return { m, s };
}

test("global mode only: a root is voiced with the global mode", () => {
  assert.deepEqual(resolveVoice(data(), "brief", "t1", "p1"),
    { mode: "brief", voiced: true, modeFrom: "global", isChild: false, childrenFrom: null });
});

test("thread beats project beats global; global quiet with a thread on Brief is voiced", () => {
  const d = data({ threads: { t1: { mode: "brief" } }, projects: { p1: { mode: "verbose" } } });
  assert.deepEqual([resolveVoice(d, "quiet", "t1", "p1").mode, resolveVoice(d, "quiet", "t1", "p1").voiced], ["brief", true]);
  assert.equal(resolveVoice(d, "brief", "t2", "p1").modeFrom, "project");
});

test("quiet anywhere in the chain means not voiced; an unknown global is not treated as quiet", () => {
  assert.equal(resolveVoice(data({ projects: { p1: { mode: "quiet" } } }), "brief", "t1", "p1").voiced, false);
  assert.equal(resolveVoice(data(), "quiet", "t1", "p1").voiced, false);
  assert.deepEqual(resolveVoice(data(), null, "t1", "p1"),
    { mode: "brief", voiced: true, modeFrom: "global", isChild: false, childrenFrom: null });
});

test("a child inherits its nearest ancestor's mode", () => {
  const d = data({ threads: { t1: { mode: "verbose", voiceChildren: true } }, parents: { c1: "t1", g1: "c1" } });
  assert.deepEqual(resolveVoice(d, "brief", "g1", "p1"),
    { mode: "verbose", voiced: true, modeFrom: "parent", isChild: true, childrenFrom: "parent" });
});

test("a child is unvoiced by default, voiced by project voiceChildren or its own mode", () => {
  assert.equal(resolveVoice(data({ parents: { c1: "t1" } }), "brief", "c1", "p1").voiced, false);
  const proj = resolveVoice(data({ parents: { c1: "t1" }, projects: { p1: { voiceChildren: true } } }), "brief", "c1", "p1");
  assert.deepEqual([proj.voiced, proj.childrenFrom], [true, "project"]);
  assert.equal(resolveVoice(data({ parents: { c1: "t1" }, threads: { c1: { mode: "brief" } } }), "brief", "c1", "p1").voiced, true);
});

test("the nearest ancestor's voiceChildren wins over a farther one and the project", () => {
  const d = data({ parents: { c1: "t1", g1: "c1" }, threads: { t1: { voiceChildren: true }, c1: { voiceChildren: false } },
    projects: { p1: { voiceChildren: true } } });
  assert.equal(resolveVoice(d, "brief", "g1", "p1").voiced, false);
});

test("unknown parent resolves as root; cycles and depth are bounded", () => {
  assert.equal(resolveVoice(data(), "brief", "c1", "p1").isChild, false);
  assert.equal(resolveVoice(data({ parents: { a: "b", b: "a" } }), "brief", "a", null).mode, "brief");
  const deep: Record<string, string> = {};
  for (let i = 0; i < 40; i++) deep[`n${i}`] = `n${i + 1}`;
  assert.equal(resolveVoice(data({ parents: deep, threads: { n39: { mode: "full" } } }), "brief", "n0", null).mode, "brief",
    "an ancestor beyond 16 steps is not consulted");
});

test("set merges, null clears, and an empty setting is deleted", async () => {
  const { m, s } = await store();
  await s.set("thread", "t1", { mode: "verbose", voiceChildren: true });
  await s.set("thread", "t1", { mode: null });
  assert.deepEqual(s.get().threads.t1, { voiceChildren: true });
  await s.set("thread", "t1", { voiceChildren: null });
  assert.equal("t1" in s.get().threads, false);
  assert.deepEqual(m.get("voice-scopes"), { threads: {}, projects: {} });
});

test("writes are serialized in call order", async () => {
  const { s } = await store();
  await Promise.all([s.set("project", "p1", { mode: "ambient" }), s.set("project", "p1", { voiceChildren: true })]);
  assert.deepEqual(s.get().projects.p1, { mode: "ambient", voiceChildren: true });
});

test("a failed settings write rejects, keeps the old data, and notifies nobody", async () => {
  const { s } = await store("voice-scopes");
  const kinds: string[] = [];
  s.onChange((k) => kinds.push(k));
  await assert.rejects(s.set("thread", "t1", { mode: "brief" }));
  assert.deepEqual([s.get().threads, kinds], [{}, []]);
});

test("a failed parents write does not block settings", async () => {
  const { s } = await store("voice-parents");
  await assert.rejects(s.learnParent("c1", "t1"));
  await s.set("thread", "t1", { mode: "brief" });
  assert.deepEqual(s.get().threads.t1, { mode: "brief" });
});

test("learnParent writes once per change, even for concurrent calls; roots are not stored", async () => {
  const { s } = await store();
  const kinds: string[] = [];
  s.onChange((k) => kinds.push(k));
  await Promise.all([s.learnParent("c1", "t1"), s.learnParent("c1", "t1")]);
  await s.learnParent("t1", null);
  assert.deepEqual(kinds, ["parents"]);
  assert.equal(s.parentOf("c1"), "t1");
});

test("the parent map is capped, dropping the oldest", async () => {
  const { s } = await store();
  for (let i = 0; i < MAX_PARENTS + 3; i++) await s.learnParent(`c${i}`, "t1");
  assert.equal(Object.keys(s.get().parents).length, MAX_PARENTS);
  assert.equal(s.parentOf("c0"), undefined);
  assert.equal(s.parentOf(`c${MAX_PARENTS + 2}`), "t1");
});

test("forget drops setting and link and reports settings only when a setting went", async () => {
  const { s } = await store();
  await s.learnParent("c1", "t1");
  await s.set("thread", "c1", { mode: "brief" });
  const kinds: string[] = [];
  s.onChange((k) => kinds.push(k));
  await s.forget("c1");
  assert.deepEqual([s.parentOf("c1"), "c1" in s.get().threads], [undefined, false]);
  assert.deepEqual(kinds.sort(), ["parents", "settings"]);
});

test("load keeps good entries and drops bad ones", async () => {
  const { m, kv } = memKv();
  m.set("voice-scopes", { threads: { t1: { mode: "brief" }, t2: { mode: "shout" }, t3: 5 }, projects: "x" });
  m.set("voice-parents", { parents: { c1: "t1", c2: 7 } });
  const d = await new VoiceScopes(kv).load();
  assert.deepEqual(d, { threads: { t1: { mode: "brief" } }, projects: {}, parents: { c1: "t1" } });
});
