import { test } from "node:test";
import assert from "node:assert/strict";
import { memDb } from "../test-util.ts";
import { Store } from "./store.ts";
import { LIMITS } from "../shared/constants.ts";

const env = (s: Store) => s.upsertEnv({ slug: "lab", name: "Lab", kind: "lab", color: "#22c55e", rules: "", controlHost: "control", hostId: null, repoPath: "/srv/example", inventoryRoot: "/srv/example/inventories", runnerKind: "ssh", agentApproval: "form", defaultCheck: true, infraEnvSlug: null, enabled: true });
const spec = { inventory: "inventories/staging.yml", limit: "", tags: [], skipTags: [], extraVars: {}, credRefId: null, check: true, diff: true, verbosity: 0 as const, branch: null };
const ev = (over: Record<string, unknown> = {}) => ({ kind: "play_start" as const, play: "Web", task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events" as const, at: 1, ...over });

test("env upsert, unique slug, lookup", () => {
  let t = 1000; const s = new Store(memDb(), () => t);
  const e = env(s); assert.equal(s.getEnvBySlug("lab")?.id, e.id);
  assert.equal(s.getEnv(e.id)?.defaultCheck, true);
  assert.throws(() => s.upsertEnv({ ...e, id: undefined, name: "Other" }), /slug/);
  assert.equal(s.upsertEnv({ ...e, name: "Renamed" }).id, e.id);
  s.deleteEnv(e.id); assert.equal(s.listEnvs().length, 0);
});
test("runs and events with sequence and paging", () => {
  let t = 1000; const s = new Store(memDb(), () => t); const e = env(s);
  const run = s.insertRun({ envId: e.id, runnerKind: "ssh", playbook: "site.yml", playbookName: "Web", playbookHash: null, templateId: null, spec, source: { surface: "cli", threadId: "thr_1", scheduleId: null }, approval: "interaction" });
  assert.match(run.id, /^run_[0-9A-Za-z]{20}$/); assert.equal(run.status, "queued");
  const next = s.appendEvents(run.id, [{ kind: "play_start", play: "Web", task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events", at: t }, { kind: "host_failed", play: "Web", task: "x", taskAction: "apt", nodeId: "p0/t0", host: "web-02", changed: false, failed: true, msg: "boom", res: null, diff: null, stdout: null, source: "events", at: t }]);
  assert.equal(next, 3);
  assert.equal(s.listEvents(run.id, { cursor: 0, limit: 10, failedOnly: true }).length, 1);
  assert.equal(s.listEvents(run.id, { cursor: 1, limit: 10 }).length, 1);
  assert.equal(s.listEvents(run.id, { cursor: 0, limit: 10, host: "web-02" }).length, 1);
  assert.equal(s.listEvents(run.id, { cursor: 0, limit: 10, node: "p0/t0" }).length, 1);
  assert.equal(s.lastEventOfKind(run.id, "host_failed")?.seq, 2); assert.equal(s.lastEventOfKind(run.id, "stats"), null);
  s.updateRun(run.id, { status: "running", startedAt: t });
  assert.deepEqual(s.listOpenRuns().map((r) => r.id), [run.id]);
  s.updateRun(run.id, { status: "failed", endedAt: t + 5 });
  assert.equal(s.listRuns({ limit: 10 })[0]!.status, "failed");
  t += 91 * 86_400_000; s.prune(t - 90 * 86_400_000); assert.equal(s.getRun(run.id), null); assert.equal(s.lastEventSeq(run.id), 0);
});
test("event and run fields truncate to limits", () => {
  const s = new Store(memDb(), () => 1); const e = env(s);
  const run = s.insertRun({ envId: e.id, runnerKind: "ssh", playbook: "site.yml", playbookName: "Web", playbookHash: null, templateId: null, spec, source: { surface: "cli", threadId: null, scheduleId: null }, approval: "none" });
  s.appendEvents(run.id, [ev({ msg: "m".repeat(LIMITS.msg + 10), res: "r".repeat(LIMITS.res + 10), diff: "d".repeat(LIMITS.diff + 10), stdout: "o".repeat(LIMITS.stdout + 10) })]);
  const [row] = s.listEvents(run.id, { cursor: 0, limit: 1 });
  assert.equal(row!.msg!.length, LIMITS.msg); assert.equal(row!.res!.length, LIMITS.res);
  assert.equal(row!.diff!.length, LIMITS.diff); assert.equal(row!.stdout!.length, LIMITS.stdout);
  const r = s.updateRun(run.id, { error: "e".repeat(LIMITS.error + 5), lastLine: "l".repeat(LIMITS.lastLine + 5) });
  assert.equal(r!.error!.length, LIMITS.error); assert.equal(r!.lastLine!.length, LIMITS.lastLine);
});
test("inventories and credrefs", () => {
  const s = new Store(memDb(), () => 5); const e = env(s);
  s.replaceDiscoveredInventories(e.id, [{ name: "staging", kind: "file", path: "inventories/staging.yml" }]);
  s.replaceDiscoveredInventories(e.id, [{ name: "prod", kind: "file", path: "inventories/prod.yml" }]);
  const inv = s.listInventories(e.id); assert.deepEqual(inv.map((i) => i.path), ["inventories/prod.yml"]);
  s.setInventoryGroups(inv[0]!.id, JSON.stringify(["web"])); assert.equal(s.listInventories(e.id)[0]!.groups, '["web"]');
  const c = s.upsertCredRef({ envId: e.id, name: "deploy", sshUser: "deploy", keyPath: null, becomeMethod: null, vaultPasswordFile: null, ansibleCfg: null });
  assert.equal(s.listCredRefs(e.id)[0]!.sshUser, "deploy"); s.deleteCredRef(c.id); assert.equal(s.listCredRefs(e.id).length, 0);
});
test("investigations and thread files", () => {
  const s = new Store(memDb(), () => 1); const e = env(s);
  const run = s.insertRun({ envId: e.id, runnerKind: "ssh", playbook: "site.yml", playbookName: "Web", playbookHash: null, templateId: null, spec, source: { surface: "panel", threadId: null, scheduleId: null }, approval: "none" });
  const inv = s.insertInvestigation({ runId: run.id, threadId: "thr_9", host: "web-02", nodeId: "p0/t1", scope: "cell", permissionMode: "accept-edits" });
  assert.equal(s.investigationByThread("thr_9")?.id, inv.id);
  assert.equal(s.investigationByThread("thr_9")?.permissionMode, "accept-edits");
  s.updateInvestigation(inv.id, { status: "idle", summary: "Template path is wrong" });
  assert.equal(s.listInvestigations(run.id)[0]!.summary, "Template path is wrong");
  s.touchThreadFile("thr_1", e.id, "site.yml"); s.touchThreadFile("thr_1", e.id, "site.yml");
  assert.deepEqual(s.threadFiles("thr_1").map((f) => f.path), ["site.yml"]);
  assert.deepEqual(s.filesByEnv(e.id).map((f) => f.path), ["site.yml"]);
});

test("failedOnly excludes an ignored host_failed but keeps real failures and unreachable hosts", () => {
  const s = new Store(memDb(), () => 1000); const e = env(s);
  const run = s.insertRun({ envId: e.id, runnerKind: "ssh", playbook: "site.yml", playbookName: "Web", playbookHash: null, templateId: null, spec, source: { surface: "cli", threadId: null, scheduleId: null }, approval: "interaction" });
  const ev = (kind: "host_failed" | "host_unreachable", host: string, failed: boolean) => ({ kind, play: "Web", task: "y", taskAction: null, nodeId: null, host, changed: false, failed, msg: null, res: null, diff: null, stdout: null, source: "events" as const, at: 1 });
  s.appendEvents(run.id, [ev("host_failed", "web-01", false), ev("host_failed", "web-02", true), ev("host_unreachable", "db-01", true)]);
  assert.deepEqual(s.listEvents(run.id, { cursor: 0, limit: 10, failedOnly: true }).map((x) => x.host), ["web-02", "db-01"]);
});
