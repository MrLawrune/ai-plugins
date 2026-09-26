import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeActions, fakeProvider, inv, memDb } from "../test-util.ts";
import type { InfraProvider, TaskEntry } from "./providers/types.ts";
import { Store, type ActionRow } from "./store.ts";
import { Tracker } from "./tasks.ts";

const UPID = "UPID:pve1:1:2:3:vzstop:201:u@pve!t:";
function setup(provider: InfraProvider, t0 = 1_000_000, healthy: (connectionId: string) => boolean = () => true) {
  let t = t0;
  const store = new Store(memDb(), () => t);
  const updates: ActionRow[] = [];
  const finished: ActionRow[] = [];
  const tracker = new Tracker({ store, providerFor: () => provider, healthy, now: () => t, onUpdate: (r) => updates.push(r), onFinished: (r) => finished.push(r), log: () => undefined });
  const add = (over: Partial<ActionRow> = {}) => store.addAction({
    envId: "e", connectionId: "c1", target: "lab/pve1/201", guestName: "proxy", action: "stop", params: {}, confirm: "dialog",
    sourceSurface: "page", sourceThreadId: null, credential: "action", upid: UPID, status: "running",
    exitstatus: null, error: null, lastLine: null, requestedAt: t, endedAt: null, ...over,
  });
  return { store, tracker, add, updates, finished, advance: (ms: number) => { t += ms; }, now: () => t };
}
const sig = new AbortController().signal;

test("running → ok: records the last log line, then finishes and triggers a refresh", async () => {
  let running = true;
  const actions = fakeActions({
    taskStatus: async () => ({ running, exitstatus: running ? null : "OK" }),
    taskLog: async (_n, _u, start) => (start === 0 ? ["stopping CT 201"] : []),
  });
  const h = setup(fakeProvider([inv([])], {}, actions));
  const row = h.add();
  await h.tracker.pollOnce(sig);
  assert.equal(h.store.getAction(row.id)!.lastLine, "stopping CT 201");
  running = false;
  await h.tracker.pollOnce(sig);
  const done = h.store.getAction(row.id)!;
  assert.deepEqual([done.status, done.exitstatus, done.endedAt !== null], ["ok", "OK", true]);
  assert.equal(h.finished.length, 1);
  assert.equal(h.store.openActions().length, 0);
});

test("a non-OK exit status fails with the log tail; an aborted task is 'aborted'", async () => {
  const actions = fakeActions({
    taskStatus: async () => ({ running: false, exitstatus: "command 'lxc-stop' failed" }),
    taskLog: async () => ["line a", "line b"],
  });
  const h = setup(fakeProvider([inv([])], {}, actions));
  const failed = h.add();
  const aborted = h.add();
  const retried = h.add();
  h.tracker.markAborting(aborted.id);
  h.tracker.markAborting(retried.id);
  h.tracker.unmarkAborting(retried.id);
  await h.tracker.pollOnce(sig);
  const f = h.store.getAction(failed.id)!;
  assert.equal(f.status, "failed");
  assert.equal(f.exitstatus, "command 'lxc-stop' failed");
  assert.match(f.error!, /line a\nline b/);
  assert.equal(h.store.getAction(aborted.id)!.status, "aborted");
  assert.equal(h.store.getAction(retried.id)!.status, "failed", "an unmarked abort reads as failed");
});

test("unknown rows are reconciled from the node's task list, then followed", async () => {
  const t0 = 1_790_000_000_000;
  const tasks: TaskEntry[] = [
    { upid: "UPID:other", node: "pve1", type: "vzstart", id: "201", user: "u@pve!t", status: "OK", start: t0 / 1000 + 2, end: null },
    { upid: UPID, node: "pve1", type: "vzstop", id: "201", user: "u@pve!t", status: null, start: t0 / 1000 + 3, end: null },
  ];
  const actions = fakeActions({ taskStatus: async () => ({ running: true, exitstatus: null }) });
  const p = { ...fakeProvider([inv([])], {}, actions), tasks: async () => tasks };
  const h = setup(p, t0);
  const row = h.add({ upid: null, status: "unknown", error: "No reply from Proxmox" });
  await h.tracker.pollOnce(sig);
  const got = h.store.getAction(row.id)!;
  assert.deepEqual([got.status, got.upid], ["running", UPID]);
});

test("rows unresolved after 24 hours become unknown and stop being polled", async () => {
  const actions = fakeActions({ taskStatus: async () => { throw new Error("unreachable"); } });
  const h = setup(fakeProvider([inv([])], {}, actions));
  const row = h.add();
  h.advance(24 * 3_600_000 + 1);
  await h.tracker.pollOnce(sig);
  const got = h.store.getAction(row.id)!;
  assert.equal(got.status, "unknown");
  assert.notEqual(got.endedAt, null);
  assert.equal(h.store.openActions().length, 0);
});

test("rows on an unhealthy connection are not polled until it recovers, but still give up after 24 hours", async () => {
  let calls = 0;
  let up = false;
  const actions = fakeActions({ taskStatus: async () => { calls++; return { running: true, exitstatus: null }; } });
  const p = { ...fakeProvider([inv([])], {}, actions), tasks: async () => { calls++; return []; } };
  const h = setup(p, 1_000_000, (id) => up && id === "c1");
  const row = h.add();
  h.add({ upid: null, status: "unknown", error: "No reply from Proxmox" });
  await h.tracker.pollOnce(sig);
  assert.equal(calls, 0, "no Proxmox calls for a down connection");
  up = true;
  await h.tracker.pollOnce(sig);
  assert.equal(calls, 2, "both rows polled once healthy");
  up = false;
  h.advance(24 * 3_600_000 + 1);
  await h.tracker.pollOnce(sig);
  assert.equal(h.store.getAction(row.id)!.status, "unknown");
  assert.equal(h.store.openActions().length, 0);
});

test("a reload resumes tracking from the store", async () => {
  const actions = fakeActions({ taskStatus: async () => ({ running: false, exitstatus: "OK" }) });
  const h = setup(fakeProvider([inv([])], {}, actions));
  const row = h.add();
  const fresh = new Tracker({ store: h.store, providerFor: () => fakeProvider([inv([])], {}, actions), healthy: () => true, now: h.now, onUpdate: () => undefined, onFinished: () => undefined, log: () => undefined });
  await fresh.pollOnce(sig);
  assert.equal(h.store.getAction(row.id)!.status, "ok");
});
