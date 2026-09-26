import { test } from "node:test";
import assert from "node:assert/strict";
import { envRow, guest, host, memDb, snapshotOf } from "../test-util.ts";
import { Activity, type RawEvent } from "./activity.ts";
import { buildIndex } from "./matcher.ts";
import { Store } from "./store.ts";

function setup(pages: RawEvent[][] | Error) {
  let t = 10_000;
  const store = new Store(memDb(), () => t);
  const env = store.upsertEnv({ slug: "homelab", name: "Homelab", kind: "lab", color: "#0f0", pollSeconds: 10, rules: "", exportDir: "" });
  const index = buildIndex([snapshotOf(envRow("homelab"), [host("pve1", { ip: "192.0.2.10" })], [guest("pve1", 201, { name: "proxy" })])], new Map([["pve1", "192.0.2.10"]]), new Map());
  const calls: { afterSeq?: string; types?: readonly string[]; limit?: string }[] = [];
  const touched: string[][] = [];
  let page = 0;
  const activity = new Activity({
    store,
    events: {
      async list(args) {
        calls.push({ afterSeq: args.afterSeq, types: args.types, limit: args.limit });
        if (pages instanceof Error) throw pages;
        return pages[page++] ?? [];
      },
    },
    index: () => index,
    envIdForSlug: (slug) => (slug === "homelab" ? env.id : null),
    now: () => t,
    onActivity: (ids) => touched.push(ids),
  });
  return { activity, store, env, calls, touched, setNow: (v: number) => { t = v; } };
}

let seq = 0;
function ev(type: "item/started" | "item/completed", command: string, over: { itemId?: string; exitCode?: number; createdAt?: number; itemType?: string } = {}): RawEvent {
  seq++;
  return {
    seq, type, createdAt: over.createdAt ?? 9_000, threadId: "thr_a", scope: { kind: "turn", turnId: "t1" },
    data: { item: { type: over.itemType ?? "commandExecution", id: over.itemId ?? "i1", command, status: type === "item/started" ? "pending" : "completed", exitCode: over.exitCode } },
  };
}

test("started then completed records rows per target and clears running", async () => {
  const s0 = seq;
  const { activity, store, calls, touched } = setup([[ev("item/started", "ssh pve1 'pct exec 201 -- ls'")], [ev("item/completed", "ssh pve1 'pct exec 201 -- ls'", { exitCode: 0 })]]);
  await activity.onThreadEvents("thr_a");
  assert.deepEqual([...activity.running()], [["thr_a", ["homelab/pve1", "homelab/pve1/201"]]]);
  await activity.onThreadEvents("thr_a");
  assert.deepEqual([...activity.running()], []);
  const rows = store.activityFor({ limit: 10 });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter((r) => r.phase === "completed").map((r) => [r.target, r.exitCode, r.turnId, r.at]).sort(), [["homelab/pve1", 0, "t1", 9_000], ["homelab/pve1/201", 0, "t1", 9_000]]);
  assert.deepEqual(calls[0]!.types, ["item/started", "item/completed"]);
  assert.ok(Number(calls[0]!.limit) <= 100, "BB rejects thread event pages above 100");
  assert.equal(calls[0]!.afterSeq, "0");
  assert.equal(calls.at(-1)!.afterSeq, String(s0 + 1));
  assert.deepEqual(touched, [["thr_a"], ["thr_a"]]);
});

test("non-command items and unmatched commands record nothing and do not notify", async () => {
  const { activity, store, touched } = setup([[ev("item/completed", "ls -la"), ev("item/completed", "ssh pve1 true", { itemType: "fileChange" })]]);
  await activity.onThreadEvents("thr_a");
  assert.equal(store.activityFor({ limit: 10 }).length, 0);
  assert.deepEqual(touched, []);
});

test("cursor advances past processed events", async () => {
  const e = ev("item/completed", "ls");
  const { activity, store } = setup([[e]]);
  await activity.onThreadEvents("thr_a");
  assert.equal(store.getCursor("thr_a"), e.seq);
});

test("a failed list leaves the cursor unchanged and rethrows", async () => {
  const { activity, store } = setup(new Error("sdk down"));
  store.setCursor("thr_a", 7);
  await assert.rejects(activity.onThreadEvents("thr_a"), /sdk down/);
  assert.equal(store.getCursor("thr_a"), 7);
});

test("commands are truncated to 500 characters", async () => {
  const { activity, store } = setup([[ev("item/completed", "ssh pve1 " + "x".repeat(900))]]);
  await activity.onThreadEvents("thr_a");
  assert.equal(store.activityFor({ limit: 1 })[0]!.command.length, 500);
});

test("correlates a change with a command within two minutes on the guest or its host", async () => {
  const { activity, store, env } = setup([[ev("item/completed", "ssh pve1 pct create 245 local:vztmpl/x.tar.zst", { createdAt: 950_000 })]]);
  await activity.onThreadEvents("thr_a");
  const near = store.addChange({ envId: env.id, target: "homelab/pve1/245", kind: "guest.added", detail: "", threadId: null, at: 1_000_000 });
  const far = store.addChange({ envId: env.id, target: "homelab/pve1/246", kind: "guest.added", detail: "", threadId: null, at: 2_000_000 });
  const out = activity.correlate([
    { id: near.id, envId: env.id, target: near.target, kind: near.kind, detail: "", at: near.at },
    { id: far.id, envId: env.id, target: far.target, kind: far.kind, detail: "", at: far.at },
  ]);
  assert.deepEqual(out.map((e) => e.threadId ?? null), ["thr_a", null]);
  assert.deepEqual(store.changes({ limit: 5 }).map((c) => [c.target, c.threadId]).sort(), [["homelab/pve1/245", "thr_a"], ["homelab/pve1/246", null]]);
});

test("threadsTouching lists threads active on a target and its children", async () => {
  const { activity } = setup([[ev("item/completed", "ssh pve1 'pct exec 201 -- ls'", { createdAt: 9_500 })]]);
  await activity.onThreadEvents("thr_a");
  assert.deepEqual(activity.threadsTouching("homelab/pve1", 60_000), ["thr_a"]);
  assert.deepEqual(activity.threadsTouching("homelab/pve1/202", 60_000), []);
});

test("a thread going idle clears commands that never reported completion", async () => {
  const { activity } = setup([[ev("item/started", "ssh pve1 'pct exec 201 -- sleep 999'", { itemId: "hung" })]]);
  await activity.onThreadEvents("thr_a");
  assert.equal(activity.running().size, 1);
  assert.equal(activity.clearRunning("thr_a"), true);
  assert.equal(activity.running().size, 0);
  assert.equal(activity.clearRunning("thr_a"), false);
});
