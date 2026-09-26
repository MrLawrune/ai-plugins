import { test } from "node:test";
import assert from "node:assert/strict";
import { memDb } from "../test-util.ts";
import { Store } from "./store.ts";

const envInput = { slug: "homelab", name: "Homelab", kind: "lab" as const, color: "#22c55e", pollSeconds: 10, rules: "", exportDir: "" };
const connInput = (envId: string) => ({ envId, label: "pve1", baseUrl: "https://192.0.2.10:8006", authKind: "token" as const, username: "bb-view@pve!infra", tlsMode: "insecure" as const, tlsFingerprint: "", caPem: "", enabled: true });
const act = (envId: string, over: Partial<{ target: string; threadId: string; itemId: string; phase: "started" | "completed"; at: number }> = {}) => ({
  envId, target: "homelab/pve1/201", threadId: "thr_a", turnId: "t1", itemId: "i1", command: "ssh pve1 pct exec 201 -- ls", phase: "completed" as const, exitCode: 0, at: 900, ...over,
});

test("creates, lists, and updates envs", () => {
  const s = new Store(memDb(), () => 1000);
  const e = s.upsertEnv(envInput);
  assert.equal(e.createdAt, 1000);
  assert.equal(s.getEnvBySlug("homelab")!.id, e.id);
  const u = s.upsertEnv({ ...envInput, id: e.id, name: "Home Lab", kind: "dev" });
  assert.deepEqual([u.name, u.kind, u.createdAt], ["Home Lab", "dev", 1000]);
  assert.equal(s.listEnvs().length, 1);
});

test("rejects duplicate slugs, bad slugs, bad kinds, and out-of-range values", () => {
  const s = new Store(memDb());
  s.upsertEnv(envInput);
  assert.throws(() => s.upsertEnv(envInput), /slug "homelab" is already used/);
  assert.throws(() => s.upsertEnv({ ...envInput, slug: "Home Lab" }), /slug/);
  assert.throws(() => s.upsertEnv({ ...envInput, slug: "x", kind: "nope" as never }), /kind/);
  assert.throws(() => s.upsertEnv({ ...envInput, slug: "y", pollSeconds: 2 }), /poll/i);
  assert.throws(() => s.upsertEnv({ ...envInput, slug: "z", rules: "x".repeat(4097) }), /rules/i);
});

test("connections round-trip booleans and belong to an env", () => {
  const s = new Store(memDb());
  const e = s.upsertEnv(envInput);
  const c = s.upsertConnection(connInput(e.id));
  assert.equal(c.enabled, true);
  const off = s.upsertConnection({ ...connInput(e.id), id: c.id, enabled: false });
  assert.equal(off.enabled, false);
  assert.deepEqual(s.listConnections(e.id).map((x) => x.id), [c.id]);
  assert.throws(() => s.upsertConnection({ ...connInput("missing") }), /environment/);
});

test("env delete removes connections, activity, changes, and nothing else", () => {
  const s = new Store(memDb(), () => 1000);
  const e = s.upsertEnv(envInput);
  const other = s.upsertEnv({ ...envInput, slug: "staging", name: "Staging" });
  s.upsertConnection(connInput(e.id));
  s.upsertConnection(connInput(other.id));
  s.addActivity(act(e.id));
  s.addActivity(act(other.id, { target: "staging/s1" }));
  s.addChange({ envId: e.id, target: "homelab/pve1/201", kind: "guest.added", detail: "", threadId: null, at: 1 });
  s.deleteEnv(e.id);
  assert.deepEqual([s.listEnvs().length, s.listConnections().length, s.activityFor({ limit: 10 }).length, s.changes({ limit: 10 }).length], [1, 1, 1, 0]);
});

test("activity dedupes by thread, item, and phase", () => {
  const s = new Store(memDb());
  const e = s.upsertEnv(envInput);
  s.addActivity(act(e.id));
  s.addActivity(act(e.id));
  s.addActivity(act(e.id, { phase: "started" }));
  assert.equal(s.activityFor({ limit: 10 }).length, 2);
});

test("activityFor filters by target prefix without matching sibling ids", () => {
  const s = new Store(memDb());
  const e = s.upsertEnv(envInput);
  s.addActivity(act(e.id, { target: "homelab/pve1", itemId: "a" }));
  s.addActivity(act(e.id, { target: "homelab/pve1/201", itemId: "b" }));
  s.addActivity(act(e.id, { target: "homelab/pve11/5", itemId: "c" }));
  s.addActivity(act(e.id, { target: "homelab/pve1/2010", itemId: "d" }));
  assert.deepEqual(s.activityFor({ targetPrefix: "homelab/pve1", limit: 10 }).map((a) => a.itemId).sort(), ["a", "b", "d"]);
  assert.deepEqual(s.activityFor({ targetPrefix: "homelab/pve1/201", limit: 10 }).map((a) => a.itemId), ["b"]);
});

test("activityFor orders newest first and honors since, thread, and limit", () => {
  const s = new Store(memDb());
  const e = s.upsertEnv(envInput);
  for (let i = 0; i < 5; i++) s.addActivity(act(e.id, { itemId: `i${i}`, at: 100 * i, threadId: i % 2 ? "thr_b" : "thr_a" }));
  assert.deepEqual(s.activityFor({ limit: 2 }).map((a) => a.at), [400, 300]);
  assert.deepEqual(s.activityFor({ since: 250, limit: 10 }).map((a) => a.at), [400, 300]);
  assert.deepEqual(s.activityFor({ threadId: "thr_b", limit: 10 }).map((a) => a.at), [300, 100]);
});

test("changes record optional thread and can be linked later", () => {
  const s = new Store(memDb());
  const e = s.upsertEnv(envInput);
  const c = s.addChange({ envId: e.id, target: "homelab/pve1/245", kind: "guest.added", detail: "", threadId: null, at: 5 });
  s.linkChange(c.id, "thr_x");
  assert.equal(s.changes({ envId: e.id, limit: 5 })[0]!.threadId, "thr_x");
});

test("prune removes activity and changes older than the cutoff", () => {
  const s = new Store(memDb());
  const e = s.upsertEnv(envInput);
  s.addActivity(act(e.id, { itemId: "old", at: 10 }));
  s.addActivity(act(e.id, { itemId: "new", at: 1000 }));
  s.addChange({ envId: e.id, target: "t", kind: "guest.state", detail: "", threadId: null, at: 10 });
  s.prune(500);
  assert.deepEqual(s.activityFor({ limit: 10 }).map((a) => a.itemId), ["new"]);
  assert.equal(s.changes({ limit: 10 }).length, 0);
});

test("pins and cursors round-trip", () => {
  const s = new Store(memDb());
  s.setPin({ threadId: "thr_a", targets: ["homelab/pve1/201", "homelab"], rulesIncluded: true, pinnedAt: 7 });
  assert.deepEqual(s.listPins(), [{ threadId: "thr_a", targets: ["homelab/pve1/201", "homelab"], rulesIncluded: true, pinnedAt: 7 }]);
  s.deletePin("thr_a");
  assert.deepEqual(s.listPins(), []);
  assert.equal(s.getCursor("thr_a"), 0);
  s.setCursor("thr_a", 42);
  s.setCursor("thr_a", 43);
  assert.equal(s.getCursor("thr_a"), 43);
});

test("connections keep an optional web UI link, empty by default", () => {
  const s = new Store(memDb());
  const e = s.upsertEnv(envInput);
  const plain = s.upsertConnection(connInput(e.id));
  assert.equal(s.getConnection(plain.id)!.webUrl, "");
  const linked = s.upsertConnection({ ...connInput(e.id), webUrl: "https://pve1.example.dev" });
  assert.equal(s.getConnection(linked.id)!.webUrl, "https://pve1.example.dev");
});

test("environments carry an IP sweep interval and an optional conventions file", () => {
  const s = new Store(memDb());
  const e = s.upsertEnv(envInput);
  assert.deepEqual([e.ipRefreshMinutes, e.conventionsPath], [5, ""]);
  const u = s.upsertEnv({ ...envInput, id: e.id, ipRefreshMinutes: 0, conventionsPath: "/srv/docs/AGENTS.md" });
  assert.deepEqual([s.getEnv(u.id)!.ipRefreshMinutes, s.getEnv(u.id)!.conventionsPath], [0, "/srv/docs/AGENTS.md"]);
  assert.throws(() => s.upsertEnv({ ...envInput, id: e.id, ipRefreshMinutes: 2000 }), /IP refresh/);
  assert.throws(() => s.upsertEnv({ ...envInput, id: e.id, conventionsPath: "relative/AGENTS.md" }), /absolute/);
});
