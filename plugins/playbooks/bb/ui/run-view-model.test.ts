import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunView } from "../shared/types.ts";
import { failedHosts, failureMessages, taskKey, playFailed, recapLine, taskState } from "./run-view-model.ts";

const view = (over: Partial<RunView> = {}): RunView => ({
  runId: "run_abc123", status: "failed", playbook: "site.yml", env: { slug: "lab", name: "Lab", kind: "lab", color: "#22c55e" },
  plays: [{ id: "p0", name: "Web", tasks: [
    { nodeId: "p0/t0", name: "Install", cells: { "web-01": "ok", "web-02": "ok" } },
    { nodeId: "p0/t1", name: "Write config", cells: { "web-01": "changed", "web-02": "failed" } },
    { nodeId: "p0/t2", name: "Enable", cells: { "web-01": "skipped", "web-02": "skipped" } },
  ] }],
  hosts: ["web-01", "web-02", "db-01"], counters: { ok: 2, changed: 1, failed: 1, unreachable: 0, skipped: 2 },
  recap: null, investigations: [], startedAt: 0, endedAt: 1000, lastLine: null, ...over,
});

test("failedHosts lists hosts with a failed or unreachable cell, in host order", () => {
  const v = view();
  v.plays[0]!.tasks[0]!.cells["db-01"] = "unreachable";
  assert.deepEqual(failedHosts(v), ["web-02", "db-01"]);
  assert.deepEqual(failedHosts(view({ plays: [] })), []);
});

test("taskState: failed beats changed beats ok; all pending is pending", () => {
  const t = view().plays[0]!.tasks;
  assert.equal(taskState(t[1]!), "failed");
  assert.equal(taskState(t[0]!), "ok");
  assert.equal(taskState({ nodeId: null, name: "x", cells: { a: "pending" } }), "pending");
  assert.equal(taskState({ nodeId: null, name: "x", cells: { a: "skipped", b: "skipped" } }), "skipped");
});

test("playFailed is true when any task cell failed", () => {
  assert.equal(playFailed(view().plays[0]!), true);
  assert.equal(playFailed({ id: "p1", name: "DB", tasks: [] }), false);
});

test("failureMessages keys the first message per play, task, and host", () => {
  const ev = (play: string | null, task: string | null, host: string | null, msg: string | null) => ({ play, task, host, msg });
  const m = failureMessages([ev("Web", "Write", "web-02", "first"), ev("Web", "Write", "web-02", "second"), ev("Web", "common : Write", "web-01", "role"), ev(null, "Write", "web-02", "x"), ev("Web", "Write", "web-03", null)]);
  assert.deepEqual([...m], [[taskKey("Web", "Write"), [{ host: "web-02", msg: "first" }, { host: "web-01", msg: "role" }]]]);
});

test("recapLine uses view counters", () => {
  assert.equal(recapLine(view().counters), "ok 2 · changed 1 · failed 1 · unreachable 0 · skipped 2");
});

test("failureMessages skips ignored failures", () => {
  const ev = (host: string, failed: boolean) => ({ play: "Web", task: "Enable", host, msg: "m", kind: "host_failed", failed });
  assert.deepEqual([...failureMessages([ev("web-01", false), ev("db-01", true)])], [[taskKey("Web", "Enable"), [{ host: "db-01", msg: "m" }]]]);
});
