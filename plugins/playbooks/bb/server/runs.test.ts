import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHostClient, loadLines, memDb } from "../test-util.ts";
import { buildArgs, noticeText, RunService, type RunServiceDeps } from "./runs.ts";
import { Store } from "./store.ts";
import { parsePlaybook } from "./parser/parse.ts";
import { loadText } from "../test-util.ts";

type Probe = { runner: string | null; posix: boolean } | undefined;

function harness(probe?: Probe, over: Partial<RunServiceDeps> = {}) {
  let t = 1000; const store = new Store(memDb(), () => t);
  const env = store.upsertEnv({ slug: "lab", name: "Lab", kind: "lab", color: "#22c55e", rules: "", controlHost: "control", hostId: null, repoPath: "/srv/example", inventoryRoot: "/srv/example/inventories", runnerKind: "ssh", agentApproval: "none", defaultCheck: true, infraEnvSlug: null, enabled: true });
  const host = fakeHostClient({
    startRun: async () => ({ pid: 4242 }), cancelRun: async () => ({ ok: true }), attachRun: async () => ({ attached: true }),
    runStatus: async () => ({ status: "failed", rc: 2, lines: 0, alive: false }), tailLog: async () => ({ text: "tail" }),
    readFile: async () => ({ content: "$ANSIBLE_VAULT;1.1;AES256\n6162", hash: "h", bytes: 30 }),
  });
  const notified: string[] = []; const changed: string[] = []; const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "playbooks-runs-"));
  const svc = new RunService({
    store, host, now: () => t, log: (level, message) => { logs.push(`${level} ${message}`); }, resolveEnv: () => ({ env, hostId: "host_1", probe }), credRef: () => null,
    summaryFor: async () => null, onRunChanged: (id) => { changed.push(id); }, notifyThread: async (_id, text) => { notified.push(text); }, logDir: () => dir, ...over,
  });
  return { store, env, host, svc, notified, changed, logs, dir, advance: (ms: number) => { t += ms; } };
}
const siteSummary = parsePlaybook("lab", "site.yml", loadText("playbooks/site.yml"));
const alive = async () => ({ status: null, rc: null, lines: 1, alive: true });
const spec = { inventory: "inventories/staging.yml", limit: "", tags: [], skipTags: [], extraVars: {}, credRefId: null, check: true, diff: true, verbosity: 0 as const, branch: null };
const panel = { surface: "panel" as const, threadId: null, scheduleId: null };
const notifiedLast = (h: ReturnType<typeof harness>) => h.notified.at(-1) ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("start → lines → exit produces a finished run with recap and a thread notice", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: { surface: "cli", threadId: "thr_1", scheduleId: null }, approval: "none" });
  assert.equal(run.status, "starting");
  assert.equal(h.host.calls[0]!.method, "startRun");
  const input = h.host.calls[0]!.input as { args: string[]; ident: string; mode: string; inventory: string };
  assert.match(input.args.join(" "), /--check --diff/);
  assert.equal(input.mode, "runner"); assert.equal(input.inventory, "inventories/staging.yml");
  const ident = h.svc.ident(run.id);
  assert.equal(input.ident, ident); assert.equal(run.externalId, ident); assert.equal(run.externalUrl, "pid:4242");
  let seq = 0; for (const line of loadLines("runner_events.jsonl")) h.svc.onLine({ ident, seq: ++seq, line });
  const mid = h.store.getRun(run.id)!;
  assert.equal(mid.status, "running"); assert.ok(mid.startedAt); assert.ok(mid.lastLine);
  h.svc.onExit({ ident, code: 2, signal: null, status: "failed" });
  const done = h.store.getRun(run.id)!;
  assert.equal(done.status, "failed"); assert.equal(done.error, "exit code 2");
  assert.ok(done.recap && Object.keys(done.recap).length >= 1); assert.ok(done.endedAt);
  const text = notifiedLast(h);
  assert.match(text, /^✗ Failed {2}lab site\.yml → inventories\/staging\.yml \(check\) · \d+ hosts · \d+ failed · \d+ changed\n\n- /);
  assert.ok(text.includes(`\n\n::playbook-run{id="${run.id}"}\n\n`)); assert.ok(text.endsWith(`\n\n[playbooks:${run.id}]`));
  assert.ok(text.includes("- web-02: ok="));
  // Every block is separated by a blank line and every recap/failure line is a bullet, so Markdown keeps them apart.
  for (const block of text.split("\n\n").slice(1, -2)) for (const line of block.split("\n")) assert.match(line, /^- /);
  assert.ok(h.changed.includes(run.id));
  await sleep(300);
  assert.equal(readFileSync(done.logPath!, "utf8").split("\n").filter(Boolean).length, seq);
  // The exit dropped the tracker: a stray duplicate exit is ignored.
  h.svc.onExit({ ident, code: 0, signal: null, status: "successful" });
  assert.equal(h.store.getRun(run.id)!.status, "failed");
});

test("a clean exit is success and canceled runs report canceled", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  const ident = h.svc.ident(run.id);
  h.svc.onLine({ ident, seq: 1, line: loadLines("runner_events.jsonl")[0]! });
  h.svc.onExit({ ident, code: 0, signal: null, status: "successful" });
  assert.equal(h.store.getRun(run.id)!.status, "success"); assert.equal(h.notified.length, 0);

  const two = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  h.host.script.runStatus = alive;
  assert.deepEqual(await h.svc.cancel(two.id, false), { ok: true });
  assert.deepEqual(h.host.calls.at(-1)!.input, { controlHost: "control", pid: 4242, force: false });
  h.svc.onExit({ ident: h.svc.ident(two.id), code: 254, signal: null, status: "canceled" });
  assert.equal(h.store.getRun(two.id)!.status, "canceled");
});

test("cancel checks the supervisor is alive before signalling its pid", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  h.host.script.runStatus = async () => ({ status: null, rc: null, lines: 0, alive: false });
  await assert.rejects(h.svc.cancel(run.id, false), /no live supervisor/);
  assert.equal(h.host.calls.filter((c) => c.method === "cancelRun").length, 0);
  const status = h.host.calls.at(-1)!;
  assert.equal(status.method, "runStatus"); assert.deepEqual(status.input, { controlHost: "control", repoPath: "/srv/example", ident: h.svc.ident(run.id), pid: 4242 });
  // Unknown liveness (no pid file readable) still signals: the kill itself is the check.
  h.host.script.runStatus = async () => ({ status: null, rc: null, lines: 0, alive: null });
  assert.deepEqual(await h.svc.cancel(run.id, true), { ok: true });
});

test("out-of-order lines are buffered by seq and duplicates are dropped", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  const ident = h.svc.ident(run.id); const lines = loadLines("runner_events.jsonl");
  h.svc.onLine({ ident, seq: 2, line: lines[1]! });
  assert.equal(h.store.listEvents(run.id, { cursor: 0, limit: 10 }).length, 0);
  h.svc.onLine({ ident, seq: 1, line: lines[0]! });
  h.svc.onLine({ ident, seq: 1, line: lines[0]! });
  const events = h.store.listEvents(run.id, { cursor: 0, limit: 10 });
  assert.deepEqual(events.map((e) => e.kind), ["playbook_start", "play_start"]);
  h.svc.onNote({ ident, afterSeq: 2, text: "tail: stream.log has appeared" });
  assert.equal(h.store.listEvents(run.id, { cursor: 2, limit: 10 })[0]?.stdout, "tail: stream.log has appeared");
});

test("a lost tail re-attaches from the next line; a lost runner ends unknown", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  const ident = h.svc.ident(run.id); const lines = loadLines("runner_events.jsonl");
  h.svc.onLine({ ident, seq: 1, line: lines[0]! }); h.svc.onLine({ ident, seq: 2, line: lines[1]! });
  h.svc.onExit({ ident, code: null, signal: "tail_lost", status: null });
  await sleep(0);
  const attach = h.host.calls.at(-1)!;
  assert.equal(attach.method, "attachRun"); assert.deepEqual(attach.input, { controlHost: "control", repoPath: "/srv/example", ident, fromLine: 3, pid: 4242 });
  assert.equal(h.store.getRun(run.id)!.status, "running");
  h.svc.onExit({ ident, code: null, signal: "replaced", status: null });
  assert.equal(h.store.getRun(run.id)!.status, "running");
  h.svc.onExit({ ident, code: null, signal: "something_new", status: null });
  assert.equal(h.store.getRun(run.id)!.status, "unknown"); assert.equal(h.store.getRun(run.id)!.error, "runner lost");
  assert.ok(h.logs.some((l) => l.startsWith("warn unexpected exit signal")));
});

test("a failed re-attach drops the tracker so the next reconcile attaches afresh", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  const ident = h.svc.ident(run.id); const lines = loadLines("runner_events.jsonl");
  h.svc.onLine({ ident, seq: 1, line: lines[0]! }); h.svc.onLine({ ident, seq: 2, line: lines[1]! });
  await sleep(50);
  h.host.script.attachRun = async () => { throw new Error("ssh: connect refused"); };
  h.svc.onExit({ ident, code: null, signal: "tail_lost", status: null });
  await sleep(0);
  assert.ok(h.logs.some((l) => l.startsWith("warn re-attach failed")));
  // Lines for the dropped tracker are ignored; the reconciler re-attaches from the local copy's next line.
  h.svc.onLine({ ident, seq: 3, line: lines[2]! });
  assert.equal(h.store.listEvents(run.id, { cursor: 0, limit: 10 }).length, 2);
  h.host.script.attachRun = async () => ({ attached: true }); h.host.script.runStatus = alive;
  await h.svc.reconcile(run.id);
  const attach = h.host.calls.at(-1)!;
  assert.equal(attach.method, "attachRun"); assert.deepEqual(attach.input, { controlHost: "control", repoPath: "/srv/example", ident, fromLine: 3, pid: 4242 });
  h.svc.onLine({ ident, seq: 3, line: lines[2]! });
  assert.equal(h.store.listEvents(run.id, { cursor: 0, limit: 10 }).length, 3);
});

test("the completion notice is skipped when the environment is gone", async () => {
  const h = harness();
  let gone = false;
  const svc = new RunService({
    store: h.store, host: h.host, now: () => 5000, log: (level, message) => { h.logs.push(`${level} ${message}`); }, resolveEnv: () => { if (gone) throw new Error("no such env"); return { env: h.env, hostId: "host_1" }; }, credRef: () => null,
    summaryFor: async () => null, onRunChanged: (id) => { h.changed.push(id); }, notifyThread: async (_id, text) => { h.notified.push(text); }, logDir: () => h.dir,
  });
  const run = await svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: { surface: "cli", threadId: "thr_1", scheduleId: null }, approval: "none" });
  const ident = svc.ident(run.id);
  svc.onLine({ ident, seq: 1, line: loadLines("runner_events.jsonl")[0]! });
  gone = true; h.changed.length = 0;
  svc.onExit({ ident, code: 0, signal: null, status: "successful" });
  assert.equal(h.store.getRun(run.id)!.status, "success"); assert.deepEqual(h.changed, [run.id]); assert.equal(h.notified.length, 0);
  assert.ok(h.logs.some((l) => l.startsWith("warn run notice skipped")));
});

test("reconcile after a worker exit reads status and rc", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  h.store.updateRun(run.id, { status: "running", startedAt: 1000 });
  await h.svc.reconcile(run.id);
  assert.equal(h.store.getRun(run.id)!.status, "failed"); assert.equal(h.store.getRun(run.id)!.error, "exit code 2 (reconciled from artifacts)");
  assert.ok(h.store.getRun(run.id)!.endedAt);
});

test("resume re-attaches an open run without status and reconciles one with status", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  const ident = h.svc.ident(run.id);
  h.svc.onLine({ ident, seq: 1, line: loadLines("runner_events.jsonl")[0]! });
  await sleep(50);
  // A fresh service (as after a restart) knows nothing in memory.
  const fresh = new RunService({
    store: h.store, host: h.host, now: () => 5000, log: () => undefined, resolveEnv: () => ({ env: h.env, hostId: "host_1" }), credRef: () => null,
    summaryFor: async () => null, onRunChanged: () => undefined, notifyThread: async () => undefined, logDir: () => h.dir,
  });
  h.host.script.runStatus = async () => ({ status: null, rc: null, lines: 1, alive: true });
  await fresh.resumeOpenRuns();
  const attach = h.host.calls.at(-1)!;
  assert.equal(attach.method, "attachRun"); assert.deepEqual(attach.input, { controlHost: "control", repoPath: "/srv/example", ident, fromLine: 2, pid: 4242 });
  assert.equal(h.store.getRun(run.id)!.status, "running");
  // Lines now flow into the fresh tracker; the replayed line 1 is dropped.
  fresh.onLine({ ident, seq: 1, line: loadLines("runner_events.jsonl")[0]! });
  fresh.onLine({ ident, seq: 2, line: loadLines("runner_events.jsonl")[1]! });
  assert.deepEqual(h.store.listEvents(run.id, { cursor: 0, limit: 10 }).map((e) => e.kind), ["playbook_start", "play_start"]);
  // Without a status the reconciler tick leaves a tracked run alone (and does not attach twice).
  await fresh.resumeOpenRuns();
  assert.equal(h.store.getRun(run.id)!.status, "running"); assert.equal(h.host.calls.filter((c) => c.method === "attachRun").length, 1);
  // The host worker dies: its tail is gone, so the tracker is dropped and the run re-attached from the next line.
  await sleep(50);
  await fresh.onWorkerExit();
  const again = h.host.calls.at(-1)!;
  assert.equal(again.method, "attachRun"); assert.deepEqual(again.input, { controlHost: "control", repoPath: "/srv/example", ident, fromLine: 3, pid: 4242 });
  assert.equal(h.host.calls.filter((c) => c.method === "attachRun").length, 2);
  fresh.onLine({ ident, seq: 3, line: loadLines("runner_events.jsonl")[2]! });
  assert.equal(h.store.listEvents(run.id, { cursor: 0, limit: 10 }).length, 3);
  assert.equal(h.store.getRun(run.id)!.status, "running");
});

test("a worker exit with a finished run reads its status instead of re-attaching", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  h.svc.onLine({ ident: h.svc.ident(run.id), seq: 1, line: loadLines("runner_events.jsonl")[0]! });
  h.host.script.runStatus = async () => ({ status: "successful", rc: 0, lines: 1, alive: false });
  await h.svc.onWorkerExit();
  assert.equal(h.store.getRun(run.id)!.status, "success"); assert.equal(h.host.calls.filter((c) => c.method === "attachRun").length, 0);
  // The dropped tracker ignores a late exit from the dead worker.
  h.svc.onExit({ ident: h.svc.ident(run.id), code: 2, signal: null, status: "failed" });
  assert.equal(h.store.getRun(run.id)!.status, "success");
});

test("resume finishes an untracked run whose artifacts carry a status", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  h.svc.onLine({ ident: h.svc.ident(run.id), seq: 1, line: loadLines("runner_events.jsonl")[0]! });
  const fresh = new RunService({
    store: h.store, host: h.host, now: () => 5000, log: () => undefined, resolveEnv: () => ({ env: h.env, hostId: "host_1" }), credRef: () => null,
    summaryFor: async () => null, onRunChanged: () => undefined, notifyThread: async () => undefined, logDir: () => h.dir,
  });
  h.host.script.runStatus = async () => ({ status: "successful", rc: 0, lines: 2, alive: false });
  await fresh.resumeOpenRuns();
  assert.equal(h.store.getRun(run.id)!.status, "success"); assert.equal(h.host.calls.filter((c) => c.method === "attachRun").length, 0);
});

test("a tracked run with a status file is left to its exit signal unless the supervisor is dead", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: { surface: "cli", threadId: "thr_1", scheduleId: null }, approval: "none" });
  const ident = h.svc.ident(run.id); const lines = loadLines("runner_events.jsonl");
  let seq = 0; for (const line of lines.slice(0, -1)) h.svc.onLine({ ident, seq: ++seq, line });
  h.host.script.runStatus = async () => ({ status: "successful", rc: 0, lines: lines.length, alive: true });
  await h.svc.reconcile(run.id);
  assert.equal(h.store.getRun(run.id)!.status, "running", "the tail still owns the run");
  h.svc.onLine({ ident, seq: ++seq, line: lines.at(-1)! });
  h.svc.onExit({ ident, code: 0, signal: null, status: "successful" });
  const done = h.store.getRun(run.id)!;
  assert.equal(done.status, "success"); assert.ok(done.recap && Object.keys(done.recap).length >= 1, "the stats line was not lost");
  // Dead supervisor with a status: reconcile finishes from the artifacts.
  const two = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  h.svc.onLine({ ident: h.svc.ident(two.id), seq: 1, line: lines[0]! });
  h.host.script.runStatus = async () => ({ status: "failed", rc: 2, lines: 1, alive: false });
  await h.svc.reconcile(two.id);
  assert.equal(h.store.getRun(two.id)!.status, "failed"); assert.equal(h.store.getRun(two.id)!.error, "exit code 2 (reconciled from artifacts)");
});

test("a run inside the start window is not touched by reconcile", async () => {
  const h = harness();
  let release!: (v: { pid: number }) => void;
  h.host.script.startRun = () => new Promise((r) => { release = r; });
  const starting = h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  await sleep(0);
  const [row] = h.store.listOpenRuns();
  assert.equal(row!.status, "starting"); assert.equal(row!.externalId, h.svc.ident(row!.id));
  await h.svc.resumeOpenRuns();
  assert.equal(h.store.getRun(row!.id)!.status, "starting"); assert.equal(h.host.calls.filter((c) => c.method === "runStatus").length, 0);
  release({ pid: 77 });
  const run = await starting;
  assert.equal(run.id, row!.id); assert.equal(run.externalUrl, "pid:77"); assert.equal(run.status, "starting");
});

test("a run open for more than 24 h becomes unknown on resume", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  h.advance(25 * 3_600_000); h.host.script.runStatus = async () => ({ status: null, rc: null });
  await h.svc.resumeOpenRuns();
  assert.equal(h.store.getRun(run.id)!.status, "unknown");
});

test("a dead runner with no status is unknown on reconcile", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  h.advance(60_000);
  h.host.script.runStatus = async () => ({ status: null, rc: null, lines: 0, alive: false });
  await h.svc.reconcile(run.id);
  assert.equal(h.store.getRun(run.id)!.status, "unknown"); assert.equal(h.store.getRun(run.id)!.error, "runner lost");
});

test("cancel after a restart uses the pid stored on the row", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  const fresh = new RunService({
    store: h.store, host: h.host, now: () => 5000, log: () => undefined, resolveEnv: () => ({ env: h.env, hostId: "host_1" }), credRef: () => null,
    summaryFor: async () => null, onRunChanged: () => undefined, notifyThread: async () => undefined, logDir: () => h.dir,
  });
  h.host.script.runStatus = alive;
  assert.deepEqual(await fresh.cancel(run.id, true), { ok: true });
  assert.deepEqual(h.host.calls.at(-1)!.input, { controlHost: "control", pid: 4242, force: true });
  h.store.updateRun(run.id, { status: "success" });
  await assert.rejects(fresh.cancel(run.id, false), /not running/);
});

test("prepare refuses a prompting spec and detects vaulting by reading the inventory", async () => {
  const h = harness();
  const r = await h.svc.prepare({ envId: h.env.id, playbook: "site.yml", spec: { ...spec, inventory: "inventories/vaulted.yml" }, source: { surface: "cli", threadId: "t" }, noConfirm: false, vaultedInventory: true });
  assert.equal(r.allowed, false);
  const detected = await h.svc.prepare({ envId: h.env.id, playbook: "site.yml", spec, source: { surface: "cli", threadId: "t" }, noConfirm: false });
  assert.equal(detected.allowed, false);
  assert.equal(h.host.calls.at(-1)!.method, "readFile");
  h.host.script.readFile = async () => { throw new Error("is a directory"); };
  const ok = await h.svc.prepare({ envId: h.env.id, playbook: "site.yml", spec, source: { surface: "cli", threadId: "t" }, noConfirm: false });
  assert.deepEqual(ok, { allowed: true, confirm: "none", phrase: null, summaryLine: "lab site.yml → inventories/staging.yml (check)" });
});

test("a human prod check run needs no typed phrase; start verifies the phrase when a typed approval is claimed", async () => {
  const h = harness();
  const prod = h.store.upsertEnv({ ...h.env, id: undefined, slug: "prod", name: "Prod", kind: "prod" });
  const svc = new RunService({
    store: h.store, host: h.host, now: () => 1, log: () => undefined, resolveEnv: () => ({ env: prod, hostId: "host_1" }), credRef: () => null,
    summaryFor: async () => null, onRunChanged: () => undefined, notifyThread: async () => undefined, logDir: () => h.dir,
  });
  const r = await svc.prepare({ envId: prod.id, playbook: "site.yml", spec: { ...spec, limit: "web-01" }, source: { surface: "panel", threadId: null }, noConfirm: false, vaultedInventory: false });
  assert.deepEqual(r, { allowed: true, confirm: "none", phrase: null, summaryLine: "prod site.yml → inventories/staging.yml (check) · limit web-01" });
  await assert.rejects(svc.start({ envId: prod.id, playbook: "site.yml", spec, source: panel, approval: "typed", typed: "prd" }), /typed confirmation/);
  await svc.start({ envId: prod.id, playbook: "site.yml", spec, source: panel, approval: "typed", typed: "prod" });
});

test("check runs always carry --diff, whatever the caller sent", async () => {
  const h = harness();
  const noDiff = { ...spec, check: true, diff: false };
  const p = await h.svc.prepare({ envId: h.env.id, playbook: "site.yml", spec: noDiff, source: panel, noConfirm: false, vaultedInventory: false });
  assert.equal(p.allowed, true);
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec: noDiff, source: panel, approval: "none" });
  assert.deepEqual((h.host.calls.at(-1)!.input as { args: string[] }).args, ["--check", "--diff"]);
  assert.equal(run.spec.diff, true); assert.equal(h.store.getRun(run.id)!.spec.diff, true);
  // Apply keeps the caller's choice.
  await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec: { ...spec, check: false, diff: false }, source: panel, approval: "none" });
  assert.deepEqual((h.host.calls.at(-1)!.input as { args: string[] }).args, []);
});

test("credential references are looked up in the run's environment only", async () => {
  const cred = { id: "c1", envId: "other", name: "deploy", sshUser: "deploy", keyPath: null, becomeMethod: null, vaultPasswordFile: null, ansibleCfg: null };
  const asked: [string, string][] = [];
  const h = harness(undefined, { credRef: (envId, id) => { asked.push([envId, id]); return envId === "env_other" && id === "c1" ? cred : null; } });
  await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec: { ...spec, credRefId: "c1" }, source: panel, approval: "none" });
  assert.deepEqual(asked, [[h.env.id, "c1"]]);
  assert.ok(!(h.host.calls.at(-1)!.input as { args: string[] }).args.includes("-u"), "another environment's reference is not applied");
});

const taskNodes = (h: ReturnType<typeof harness>, runId: string) => h.store.listEvents(runId, { cursor: 0, limit: 1000 }).filter((e) => e.kind === "task_start").map((e) => e.nodeId);

test("events are persisted with the node id the matrix assigns, so node filters find them", async () => {
  const h = harness(undefined, { summaryFor: async () => siteSummary });
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  const ident = h.svc.ident(run.id);
  let seq = 0; for (const line of loadLines("runner_events.jsonl")) h.svc.onLine({ ident, seq: ++seq, line });
  const view = (await h.svc.view(run.id))!;
  assert.deepEqual(taskNodes(h, run.id), view.plays.flatMap((p) => p.tasks.map((t) => t.nodeId)));
  assert.ok(view.plays[1]!.tasks.some((t) => t.nodeId === "p1/t1"));
  const failures = h.store.listEvents(run.id, { cursor: 0, limit: 100, host: "db-01", node: "p1/t1", failedOnly: true });
  assert.equal(failures.length, 1); assert.equal(failures[0]!.kind, "host_failed"); assert.match(failures[0]!.msg ?? "", /./);
  // Host results and starts sit under their task's node; play-level events carry none.
  assert.ok(h.store.listEvents(run.id, { cursor: 0, limit: 100, node: "p1/t1" }).every((e) => e.kind === "task_start" || e.kind.startsWith("host_") || e.kind.startsWith("item_") || e.kind === "log"));
  assert.ok(h.store.listEvents(run.id, { cursor: 0, limit: 1000 }).filter((e) => e.kind === "play_start" || e.kind === "stats").every((e) => e.nodeId === null));
});

test("a re-attached run continues node ids from the persisted ordinals", async () => {
  const h = harness(undefined, { summaryFor: async () => siteSummary });
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  const ident = h.svc.ident(run.id); const lines = loadLines("runner_events.jsonl");
  const cut = Math.floor(lines.length / 2);
  let seq = 0; for (const line of lines.slice(0, cut)) h.svc.onLine({ ident, seq: ++seq, line });
  await sleep(50);
  const fresh = new RunService({
    store: h.store, host: h.host, now: () => 5000, log: () => undefined, resolveEnv: () => ({ env: h.env, hostId: "host_1" }), credRef: () => null,
    summaryFor: async () => siteSummary, onRunChanged: () => undefined, notifyThread: async () => undefined, logDir: () => h.dir,
  });
  h.host.script.runStatus = alive;
  await fresh.resumeOpenRuns();
  for (const line of lines.slice(cut)) fresh.onLine({ ident, seq: ++seq, line });
  const view = (await fresh.view(run.id))!;
  assert.deepEqual(taskNodes(h, run.id), view.plays.flatMap((p) => p.tasks.map((t) => t.nodeId)));
  assert.equal(h.store.listEvents(run.id, { cursor: 0, limit: 100, host: "db-01", node: "p1/t1", failedOnly: true }).length, 1);
});

test("mode falls back to jsonl or text when the probe saw no runner", async () => {
  for (const [probe, mode] of [[{ runner: null, posix: true }, "jsonl"], [{ runner: null, posix: false }, "text"], [{ runner: "2.4.0", posix: false }, "runner"]] as const) {
    const h = harness(probe);
    await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
    assert.equal((h.host.calls[0]!.input as { mode: string }).mode, mode);
  }
});

test("a text-mode run finishes with the recap parsed from PLAY RECAP", async () => {
  const h = harness({ runner: null, posix: false });
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: { surface: "cli", threadId: "thr_1", scheduleId: null }, approval: "none" });
  const ident = h.svc.ident(run.id);
  let seq = 0; for (const line of loadLines("text_log.txt")) h.svc.onLine({ ident, seq: ++seq, line });
  h.svc.onExit({ ident, code: 0, signal: null, status: "successful" });
  const done = h.store.getRun(run.id)!;
  assert.equal(done.status, "success"); assert.ok(done.recap && Object.keys(done.recap).length >= 1);
  assert.match(notifiedLast(h), /^✓ Success {2}lab/);
});

test("a failed start marks the run failed and rethrows", async () => {
  const h = harness();
  h.host.script.startRun = async () => { throw new Error("ssh: connect refused"); };
  await assert.rejects(h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: { surface: "cli", threadId: "thr_1", scheduleId: null }, approval: "none" }), /connect refused/);
  const [run] = h.store.listRuns({ limit: 1 });
  assert.equal(run!.status, "failed"); assert.match(run!.error!, /connect refused/); assert.ok(run!.endedAt);
  assert.equal(notifiedLast(h), `✗ Failed  lab site.yml → inventories/staging.yml (check) · start failed: ssh: connect refused\n\n[playbooks:${run!.id}]`);
});

test("view derives the matrix from stored events", async () => {
  const h = harness();
  const run = await h.svc.start({ envId: h.env.id, playbook: "site.yml", spec, source: panel, approval: "none" });
  const ident = h.svc.ident(run.id);
  let seq = 0; for (const line of loadLines("runner_events.jsonl")) h.svc.onLine({ ident, seq: ++seq, line });
  const v = (await h.svc.view(run.id))!;
  assert.equal(v.status, "running"); assert.ok(v.hosts.includes("web-02")); assert.ok(v.plays.length >= 1); assert.equal(v.env.slug, "lab");
  assert.equal(await h.svc.view("run_missing"), null);
});

test("buildArgs maps the spec and credential reference to ansible flags", () => {
  const cred = { id: "c", envId: "e", name: "deploy", sshUser: "deploy", keyPath: "/srv/example/.ssh/id_ed25519", becomeMethod: "sudo", vaultPasswordFile: "/srv/example/.vault", ansibleCfg: "/srv/example/ansible.cfg" };
  const full = buildArgs({ ...spec, check: false, limit: "web-01,web-02", tags: ["a", "b"], skipTags: ["slow"], extraVars: { k: "v" }, verbosity: 2 }, cred);
  assert.deepEqual(full.args, ["--diff", "--limit", "web-01,web-02", "--tags", "a,b", "--skip-tags", "slow", "-e", '{"k":"v"}', "-vv", "-u", "deploy", "--private-key", "/srv/example/.ssh/id_ed25519", "--vault-password-file", "/srv/example/.vault", "--become-method", "sudo"]);
  assert.deepEqual(full.env, { ANSIBLE_CONFIG: "/srv/example/ansible.cfg" });
  assert.deepEqual(buildArgs(spec, null), { args: ["--check", "--diff"], env: {} });
});

test("noticeText is Markdown: blank-line separated blocks with bulleted recap and failures", () => {
  const stats = { ok: 6, changed: 2, failures: 0, unreachable: 0, skipped: 0, rescued: 0, ignored: 0 };
  const run = { id: "run_abc123", status: "failed", playbook: "site.yml", error: "exit code 2", spec: { inventory: "hosts", check: false }, recap: { "web-01": { ...stats, failures: 1 }, "web-02": stats } };
  const env = { slug: "lab" };
  const failures = [{ host: "web-01", kind: "host_failed", task: "Enable and start nginx", msg: "Unit\nnot found" }];
  const text = noticeText(run as never, env as never, failures as never);
  assert.equal(text, [
    "✗ Failed  lab site.yml → hosts (apply) · 2 hosts · 1 failed · 2 changed",
    "- web-01: ok=6 changed=2 unreachable=0 failed=1 skipped=0 rescued=0 ignored=0\n- web-02: ok=6 changed=2 unreachable=0 failed=0 skipped=0 rescued=0 ignored=0",
    "- web-01 ✗ Enable and start nginx: Unit not found",
    '::playbook-run{id="run_abc123"}',
    "[playbooks:run_abc123]",
  ].join("\n\n"));
});
