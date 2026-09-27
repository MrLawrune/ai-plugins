import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaybook } from "./parser/parse.ts";
import { buildRunView, matchNodeId } from "./runview.ts";
import { loadText } from "../test-util.ts";

const s = parsePlaybook("lab", "blocks.yml", loadText("playbooks/blocks.yml"));
test("duplicate task names resolve by order within the play", () => {
  const first = matchNodeId(s, s.plays[0]!.name, "Restart service", 0);
  const second = matchNodeId(s, s.plays[0]!.name, "Restart service", 1);
  assert.ok(first && second && first !== second);
  assert.equal(matchNodeId(s, "No such play", "x", 0), null);
});
test("facts, role prefixes, and block wrappers", () => {
  const p = s.plays[0]!.name;
  assert.equal(matchNodeId(s, p, "Gathering Facts", 0), null);
  assert.equal(matchNodeId(s, p, "Deploy release", 0), null);
  assert.equal(matchNodeId(s, p, "  Sync application code ", 1), matchNodeId(s, p, "Sync application code", 0));
  assert.equal(matchNodeId(s, p, "web : Sync application code", 1), matchNodeId(s, p, "Sync application code", 0));
});
test("matrix, counters, and recap", () => {
  const site = parsePlaybook("lab", "site.yml", loadText("playbooks/site.yml"));
  const ev = (seq: number, kind: string, extra: Record<string, unknown>) => ({ runId: "run_x", seq, at: seq, kind, play: "Web servers", task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events", ...extra }) as never;
  const events = [ev(1, "play_start", {}), ev(2, "task_start", { task: "Install packages" }), ev(3, "host_ok", { task: "Install packages", host: "web-01" }), ev(4, "host_ok", { task: "Install packages", host: "web-02", changed: true }),
    ev(5, "task_start", { task: "Write nginx site config" }), ev(6, "host_failed", { task: "Write nginx site config", host: "web-02", failed: true, msg: "boom" }), ev(7, "host_ok", { task: "Write nginx site config", host: "web-01", changed: true })];
  const run = { id: "run_x", status: "failed", playbook: "site.yml", startedAt: 1, endedAt: 9, lastLine: null, recap: null } as never;
  const v = buildRunView(run, { slug: "lab", name: "Lab", kind: "lab", color: "#0f0" }, events, site, []);
  assert.deepEqual(v.hosts, ["web-01", "web-02"]);
  assert.equal(v.plays[0]!.tasks[0]!.nodeId, "p0/t0"); assert.equal(v.plays[0]!.tasks[0]!.cells["web-02"], "changed");
  assert.equal(v.plays[0]!.tasks[1]!.cells["web-02"], "failed");
  assert.deepEqual(v.counters, { ok: 1, changed: 2, failed: 1, unreachable: 0, skipped: 0 });
  assert.equal(v.plays[0]!.tasks[1]!.nodeId, "p0/t1");
});
test("a running run shows the current task as running on hosts without a result", () => {
  const run = { id: "run_y", status: "running", playbook: "site.yml", startedAt: 1, endedAt: null, lastLine: null, recap: null } as never;
  const events = [{ runId: "run_y", seq: 1, at: 1, kind: "play_start", play: "Web servers", task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events" }, { runId: "run_y", seq: 2, at: 1, kind: "task_start", play: "Web servers", task: "Install packages", taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events" }, { runId: "run_y", seq: 3, at: 1, kind: "host_ok", play: "Web servers", task: "Install packages", taskAction: null, nodeId: null, host: "web-01", changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events" }] as never[];
  const v = buildRunView(run, { slug: "lab", name: "Lab", kind: "lab", color: "#0f0" }, events, null, []);
  assert.equal(v.plays[0]!.tasks[0]!.cells["web-01"], "ok");
});
test("host_start marks running, later hosts stay pending, recap comes from stats", () => {
  const base = { at: 1, play: "P", task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events" };
  const recap = { "web-01": { ok: 1, changed: 0, failures: 0, unreachable: 0, skipped: 0, rescued: 0, ignored: 0 } };
  const events = [{ ...base, runId: "r", seq: 1, kind: "task_start", task: "Gathering Facts" }, { ...base, runId: "r", seq: 2, kind: "host_start", task: "Gathering Facts", host: "web-01" },
    { ...base, runId: "r", seq: 3, kind: "host_skipped", task: "Gathering Facts", host: "web-02" }, { ...base, runId: "r", seq: 4, kind: "stats", msg: null, res: JSON.stringify(recap) }] as never[];
  const run = { id: "r", status: "running", playbook: "a.yml", startedAt: 1, endedAt: null, lastLine: "x", recap: null } as never;
  const inv = [{ id: "i", runId: "r", threadId: "thr_1", host: "web-02", nodeId: null, scope: "host", status: "done", summary: "s", permissionMode: null, createdAt: 1, updatedAt: 1 }];
  const v = buildRunView(run, { slug: "lab", name: "Lab", kind: "lab", color: "#0f0" }, events, null, inv);
  const t = v.plays[0]!.tasks[0]!;
  assert.equal(t.name, "Gathering Facts"); assert.equal(t.nodeId, null);
  assert.equal(t.cells["web-01"], "running"); assert.equal(t.cells["web-02"], "skipped");
  assert.deepEqual(v.recap, recap);
  assert.deepEqual(v.investigations, [{ threadId: "thr_1", host: "web-02", nodeId: null, status: "done", summary: "s", permissionMode: null }]);
});

test("an ignored failure is an ok cell and is not counted as failed", () => {
  const base = { at: 1, play: "P", task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events" };
  const events = [
    { ...base, runId: "r", seq: 1, kind: "task_start", task: "Enable and start nginx" },
    { ...base, runId: "r", seq: 2, kind: "host_failed", task: "Enable and start nginx", host: "web-01", failed: false, msg: "unit missing" },
    { ...base, runId: "r", seq: 3, kind: "host_failed", task: "Enable and start nginx", host: "web-02", failed: false, changed: true },
    { ...base, runId: "r", seq: 4, kind: "host_failed", task: "Enable and start nginx", host: "db-01", failed: true, msg: "real" },
  ] as never[];
  const run = { id: "r", status: "failed", playbook: "a.yml", startedAt: 1, endedAt: 2, lastLine: null, recap: null } as never;
  const v = buildRunView(run, { slug: "lab", name: "Lab", kind: "lab", color: "#0f0" }, events, null, []);
  assert.deepEqual(v.plays[0]!.tasks[0]!.cells, { "web-01": "ok", "web-02": "changed", "db-01": "failed" });
  assert.deepEqual(v.counters, { ok: 1, changed: 1, failed: 1, unreachable: 0, skipped: 0 });
});
