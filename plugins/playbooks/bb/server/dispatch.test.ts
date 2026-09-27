import { test } from "node:test";
import assert from "node:assert/strict";
import { DispatchService, failedCells, type DispatchSpawnArgs } from "./dispatch.ts";
import { parsePlaybook } from "./parser/parse.ts";
import { buildRunView } from "./runview.ts";
import { Store } from "./store.ts";
import { BUDGETS } from "../shared/constants.ts";
import type { RunSpec } from "../shared/types.ts";
import { loadText, memDb } from "../test-util.ts";

const spec: RunSpec = { inventory: "inventories/lab", limit: "", tags: [], skipTags: [], extraVars: {}, credRefId: null, check: false, diff: true, verbosity: 0, branch: null };
const envInput = {
  slug: "lab", name: "Lab", kind: "lab" as const, color: "#22c55e", rules: "Always run in check mode first.", controlHost: "control", hostId: null,
  repoPath: "/srv/example", inventoryRoot: "", runnerKind: "ssh", agentApproval: "form", defaultCheck: true, infraEnvSlug: null, enabled: true,
};
const SOURCE = { id: "thr_src", projectId: "proj_1", environmentId: "env_1", providerId: "claude-code", model: "claude-fable-5-1" };

type Spawned = DispatchSpawnArgs & { pluginMetadata: { playbooks: Record<string, unknown> } };

/** A store with one env and one failed run (web-02 failed at p0/t1, "Write nginx site config"), plus a scripted SDK. */
function harness(opts: { sourceThreadId?: string | null } = {}) {
  const store = new Store(memDb(), () => 1000);
  const env = store.upsertEnv(envInput);
  const content = loadText("playbooks/site.yml");
  const summary = parsePlaybook("lab", "site.yml", content);
  const sourceThreadId = opts.sourceThreadId === undefined ? "thr_src" : opts.sourceThreadId;
  const run = store.insertRun({ envId: env.id, runnerKind: "ssh", playbook: "site.yml", playbookName: summary.name, playbookHash: null, templateId: null, spec, source: { surface: sourceThreadId ? "panel" : "page", threadId: sourceThreadId, scheduleId: null }, approval: "none" });
  store.updateRun(run.id, { status: "failed", startedAt: 1, endedAt: 9 });
  const base = { at: 1, play: "Web servers", task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events" as const };
  store.appendEvents(run.id, [
    { ...base, kind: "play_start" },
    { ...base, kind: "task_start", task: "Install packages" },
    { ...base, kind: "host_ok", task: "Install packages", host: "web-01" },
    { ...base, kind: "host_ok", task: "Install packages", host: "web-02" },
    { ...base, kind: "host_ok", task: "Install packages", host: "db-01" },
    { ...base, kind: "task_start", task: "Write nginx site config" },
    { ...base, kind: "host_ok", task: "Write nginx site config", host: "web-01", changed: true },
    { ...base, kind: "host_failed", task: "Write nginx site config", host: "web-02", failed: true, msg: "Could not find or access 'templates/site.conf.j2'", res: JSON.stringify({ changed: false, msg: "Could not find or access 'templates/site.conf.j2'" }), stdout: "fatal: [web-02]: FAILED! => template missing" },
    { ...base, kind: "host_unreachable", task: "Write nginx site config", host: "db-01", failed: true, msg: "Failed to connect to the host via ssh" },
  ]);
  const spawned: Spawned[] = [];
  const sdk = {
    threads: {
      spawn: async (args: DispatchSpawnArgs) => { spawned.push(args as Spawned); return { id: "thr_inv" }; },
      get: async (_: { threadId: string }) => SOURCE,
    },
  };
  const changed: string[] = [];
  const warnings: string[] = [];
  const badge = { slug: env.slug, name: env.name, kind: env.kind, color: env.color };
  const dispatch = new DispatchService({
    store,
    envs: { get: (s: string) => (s === "lab" || s === env.id ? env : null), health: () => null },
    library: { summary: async () => ({ summary, content }) },
    runs: {
      view: async (id: string) => {
        const r = store.getRun(id);
        return r ? buildRunView(r, badge, store.listEvents(id, { cursor: 0, limit: 10_000 }), summary, store.listInvestigations(id)) : null;
      },
    },
    sdk,
    now: () => 1000,
    log: (level, message) => { if (level === "warn") warnings.push(message); },
    onRunChanged: (id) => changed.push(id),
  });
  return { store, env, run, sdk, spawned, changed, warnings, dispatch, summary };
}

test("investigate spawns a readonly child thread with the failure and links it to the run", async () => {
  const h = harness();
  const r = await h.dispatch.investigate({ runId: h.run.id, host: "web-02", node: "p0/t1", threadId: "thr_src" });
  assert.equal(r.threadId, "thr_inv");
  const args = h.spawned[0]!;
  assert.equal(args.permissionMode, "readonly");
  assert.equal(args.parentThreadId, "thr_src");
  assert.equal(args.projectId, "proj_1");
  assert.deepEqual(args.environment, { type: "reuse", environmentId: "env_1" });
  assert.equal(args.providerId, "claude-code");
  assert.equal(args.model, "claude-fable-5-1");
  assert.equal(args.title, "Investigate site.yml on web-02");
  assert.ok(args.prompt.includes("failed host: web-02"), args.prompt);
  assert.ok(args.prompt.includes("templates/site.conf.j2"), args.prompt);
  assert.ok(args.prompt.includes("diagnose only"), args.prompt);
  assert.ok(Buffer.byteLength(args.prompt) <= BUDGETS.investigate);
  assert.deepEqual(args.pluginMetadata.playbooks, { runId: h.run.id, host: "web-02", nodeId: "p0/t1", kind: "investigation" });
  const rows = h.store.listInvestigations(h.run.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.threadId, "thr_inv");
  assert.equal(rows[0]!.scope, "cell");
  assert.equal(rows[0]!.status, "running");
  assert.equal(r.permissionMode, "readonly");
  assert.equal(rows[0]!.permissionMode, "readonly");
  assert.deepEqual(h.changed, [h.run.id]);

  h.dispatch.onThreadIdle("thr_inv", "The template path is relative to the playbook, not the repo.\nDetails…");
  const after = h.store.listInvestigations(h.run.id)[0]!;
  assert.equal(after.summary, "The template path is relative to the playbook, not the repo.");
  assert.equal(after.status, "idle");
  assert.deepEqual(h.changed, [h.run.id, h.run.id]);
});

test("investigate on the whole run covers every failed host and is top-level for a page run", async () => {
  const h = harness({ sourceThreadId: null });
  const r = await h.dispatch.investigate({ runId: h.run.id, projectId: "proj_page" });
  assert.equal(r.threadId, "thr_inv");
  const args = h.spawned[0]!;
  assert.equal(args.parentThreadId, undefined);
  assert.equal(args.projectId, "proj_page");
  assert.deepEqual(args.environment, { type: "project-default" });
  assert.equal(args.providerId, undefined);
  assert.equal(args.title, "Investigate site.yml on web-02, db-01");
  assert.ok(args.prompt.includes("failed host: web-02") && args.prompt.includes("failed host: db-01"), args.prompt);
  assert.ok(args.prompt.includes("Failed to connect"), args.prompt);
  assert.equal(h.store.listInvestigations(h.run.id)[0]!.scope, "run");
  assert.equal(h.store.listInvestigations(h.run.id)[0]!.host, null);
});

test("investigate falls back to the run's source thread and uses the task scope for a node", async () => {
  const h = harness();
  await h.dispatch.investigate({ runId: h.run.id, node: "p0/t1" });
  const args = h.spawned[0]!;
  assert.equal(args.parentThreadId, "thr_src");
  assert.equal(args.projectId, "proj_1");
  assert.equal(h.store.listInvestigations(h.run.id)[0]!.scope, "task");
  assert.equal(h.store.listInvestigations(h.run.id)[0]!.nodeId, "p0/t1");
});

test("investigate needs a project when there is no source thread", async () => {
  const h = harness({ sourceThreadId: null });
  await assert.rejects(h.dispatch.investigate({ runId: h.run.id }), /project/i);
  await assert.rejects(h.dispatch.investigate({ runId: "run_missing1", projectId: "p" }), /unknown run/i);
  assert.equal(h.spawned.length, 0);
});

test("investigate retries with accept-edits when the host rejects the readonly mode", async () => {
  const h = harness();
  let calls = 0;
  h.sdk.threads.spawn = async (args) => {
    calls += 1;
    if (args.permissionMode === "readonly") throw Object.assign(new Error("HTTP 400: Invalid input"), { code: "invalid_request", status: 400 });
    h.spawned.push(args as Spawned);
    return { id: `thr_inv_${h.spawned.length}` };
  };
  const r = await h.dispatch.investigate({ runId: h.run.id, host: "web-02", node: "p0/t1" });
  assert.equal(calls, 2);
  assert.equal(h.spawned[0]!.permissionMode, "accept-edits");
  assert.equal(r.permissionMode, "accept-edits");
  assert.equal(h.store.listInvestigations(h.run.id)[0]!.permissionMode, "accept-edits");
  assert.ok(h.warnings.some((w) => /readonly/.test(w)));
  // The rejection is remembered: the next investigation spawns once, straight with accept-edits.
  await h.dispatch.investigate({ runId: h.run.id, node: "p0/t1" });
  assert.equal(calls, 3);
  assert.equal(h.spawned[1]!.permissionMode, "accept-edits");
});

test("only invalid_request or a permission-mode message counts as a readonly rejection", async () => {
  const h = harness();
  h.sdk.threads.spawn = async () => { throw Object.assign(new Error("HTTP 400: Environment not found"), { code: "not_found", status: 400 }); };
  await assert.rejects(h.dispatch.investigate({ runId: h.run.id }), /Environment not found/);
});

test("a long instruction survives the New-thread budget", async () => {
  const h = harness();
  const instruction = "make this idempotent ".repeat(190).trim(); // ≈ 4000 chars
  const r = await h.dispatch.spawn({ target: "lab/site.yml#p0/t1", instruction, projectId: "proj_1" });
  assert.equal(r.threadId, "thr_inv");
  const prompt = h.spawned[0]!.prompt;
  assert.ok(Buffer.byteLength(prompt) <= BUDGETS.newThread);
  assert.ok(prompt.includes(`instruction: ${instruction}`), prompt.slice(-300));
  assert.ok(prompt.trimEnd().endsWith("paste the ::playbook line"));
});

test("failed cells are picked by row ordinal, so same-named tasks keep their own message", async () => {
  const store = new Store(memDb(), () => 1000);
  const env = store.upsertEnv(envInput);
  const run = store.insertRun({ envId: env.id, runnerKind: "ssh", playbook: "deploy.yml", playbookName: "Deploy", playbookHash: null, templateId: null, spec, source: { surface: "page", threadId: null, scheduleId: null }, approval: "none" });
  store.updateRun(run.id, { status: "failed", startedAt: 1, endedAt: 9 });
  const base = { at: 1, play: "Application deploy", task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events" as const };
  store.appendEvents(run.id, [
    { ...base, kind: "play_start" },
    { ...base, kind: "task_start", task: "Restart service" },
    { ...base, kind: "host_failed", task: "Restart service", host: "web-01", failed: true, msg: "first restart failed" },
    { ...base, kind: "task_start", task: "Restart service" },
    { ...base, kind: "host_failed", task: "Restart service", host: "web-01", failed: true, msg: "second restart failed" },
  ]);
  const badge = { slug: env.slug, name: env.name, kind: env.kind, color: env.color };
  const view = buildRunView(store.getRun(run.id)!, badge, store.listEvents(run.id, { cursor: 0, limit: 10_000 }), null, []);
  const cells = failedCells(view, store.listEvents(run.id, { cursor: 0, limit: 10_000 }), {});
  assert.deepEqual(cells.map((c) => c.msg), ["first restart failed", "second restart failed"]);
});

test("a source thread that cannot have children yields a top-level spawn; a rejected parent is retried top-level", async () => {
  const h = harness();
  h.sdk.threads.get = async () => ({ ...SOURCE, canSpawnChild: false });
  await h.dispatch.spawn({ target: "lab/site.yml", instruction: "x", projectId: "proj_1", threadId: "thr_src" });
  assert.equal(h.spawned[0]!.parentThreadId, undefined);
  assert.deepEqual(h.spawned[0]!.environment, { type: "reuse", environmentId: "env_1" });

  const g = harness();
  let calls = 0;
  g.sdk.threads.spawn = async (args) => {
    calls += 1;
    if (args.parentThreadId) throw Object.assign(new Error("HTTP 400: Parent thread is invalid"), { status: 400 });
    g.spawned.push(args as Spawned);
    return { id: "thr_inv" };
  };
  await g.dispatch.investigate({ runId: g.run.id, host: "web-02", node: "p0/t1", threadId: "thr_src" });
  assert.equal(calls, 2);
  assert.equal(g.spawned[0]!.parentThreadId, undefined);
  assert.equal(g.spawned[0]!.permissionMode, "readonly");
  assert.ok(g.warnings.some((w) => /parent thread/.test(w)));
});

test("investigate does not retry other spawn failures", async () => {
  const h = harness();
  h.sdk.threads.spawn = async () => { throw new Error("project not found"); };
  await assert.rejects(h.dispatch.investigate({ runId: h.run.id }), /project not found/);
  assert.equal(h.store.listInvestigations(h.run.id).length, 0);
});

test("thread failed and deleted update the row; unknown threads are ignored", async () => {
  const h = harness();
  await h.dispatch.investigate({ runId: h.run.id, host: "web-02", node: "p0/t1" });
  h.dispatch.onThreadFailed("thr_inv");
  assert.equal(h.store.listInvestigations(h.run.id)[0]!.status, "failed");
  h.dispatch.onThreadDeleted("thr_inv");
  assert.equal(h.store.listInvestigations(h.run.id)[0]!.status, "deleted");
  h.dispatch.onThreadIdle("thr_other", "text");
  h.dispatch.onThreadIdle("thr_inv", null);
  assert.equal(h.store.listInvestigations(h.run.id)[0]!.status, "idle");
  assert.equal(h.store.listInvestigations(h.run.id)[0]!.summary, null);
  assert.equal(h.changed.length, 4);
});

test("spawn for a task target carries the instruction and context under budget", async () => {
  const h = harness();
  const r = await h.dispatch.spawn({ target: "lab/site.yml#p0/t1", instruction: "make this step idempotent", projectId: "proj_1", threadId: "thr_src" });
  assert.equal(r.threadId, "thr_inv");
  const args = h.spawned[0]!;
  assert.ok(args.prompt.startsWith("## Playbooks context — lab/site.yml#p0/t1"), args.prompt);
  assert.ok(args.prompt.includes("instruction: make this step idempotent"), args.prompt);
  assert.ok(args.prompt.includes("Write nginx site config"), args.prompt);
  assert.ok(Buffer.byteLength(args.prompt) <= BUDGETS.newThread);
  assert.equal(args.permissionMode, undefined);
  assert.equal(args.parentThreadId, "thr_src");
  assert.deepEqual(args.environment, { type: "reuse", environmentId: "env_1" });
  assert.deepEqual(args.pluginMetadata.playbooks, { target: "lab/site.yml#p0/t1", runId: null, kind: "dispatch" });
  assert.equal(args.title, "site.yml: make this step idempotent");
});

test("spawn without a source thread uses the project default environment", async () => {
  const h = harness();
  await h.dispatch.spawn({ target: "lab", instruction: "", projectId: "proj_2" });
  const args = h.spawned[0]!;
  assert.equal(args.projectId, "proj_2");
  assert.deepEqual(args.environment, { type: "project-default" });
  assert.equal(args.parentThreadId, undefined);
  assert.equal(args.title, "Playbooks: lab");
});

test("prompt renders a target, a run cell, and the run itself; unknown refs throw", async () => {
  const h = harness();
  const t = await h.dispatch.prompt({ target: "lab/site.yml#p0/t1", instruction: "" });
  assert.ok(t.prompt.includes("step: 2 \"Write nginx site config\""), t.prompt);
  assert.ok(!t.prompt.includes("instruction:"));
  const withRun = await h.dispatch.prompt({ target: "lab/site.yml#p0/t1", runId: h.run.id, instruction: "" });
  assert.ok(withRun.prompt.includes(`last run: ${h.run.id} failed`), withRun.prompt);
  assert.ok(withRun.prompt.includes("web-02 ✗"), withRun.prompt);
  const cell = await h.dispatch.prompt({ target: `${h.run.id}/web-02/p0/t1`, instruction: "why?" });
  assert.ok(cell.prompt.includes("failed host: web-02") && cell.prompt.includes("\ninstruction: why?\n"), cell.prompt);
  const run = await h.dispatch.prompt({ target: h.run.id, instruction: "" });
  assert.ok(run.prompt.startsWith(`## Playbooks context — ${h.run.id}`), run.prompt);
  await assert.rejects(h.dispatch.prompt({ target: "nope/../x", instruction: "" }), /unknown target/);
  await assert.rejects(h.dispatch.prompt({ target: "other/site.yml", instruction: "" }), /unknown environment/);
});

test("context uses the add-to-chat budget for mentions", async () => {
  const h = harness();
  const text = await h.dispatch.context({ ref: "lab/site.yml", budget: BUDGETS.addToChat });
  assert.ok(text.startsWith("## Playbooks context — lab/site.yml"));
  assert.ok(Buffer.byteLength(text) <= BUDGETS.addToChat);
});

test("ignored failures are not investigated", async () => {
  const store = new Store(memDb(), () => 1000);
  const env = store.upsertEnv(envInput);
  const run = store.insertRun({ envId: env.id, runnerKind: "ssh", playbook: "deploy.yml", playbookName: "Deploy", playbookHash: null, templateId: null, spec, source: { surface: "page", threadId: null, scheduleId: null }, approval: "none" });
  const base = { at: 1, play: "Web", task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events" as const };
  store.appendEvents(run.id, [
    { ...base, kind: "play_start" },
    { ...base, kind: "task_start", task: "Enable and start nginx" },
    { ...base, kind: "host_failed", task: "Enable and start nginx", host: "web-01", failed: false, msg: "ignored" },
    { ...base, kind: "host_failed", task: "Enable and start nginx", host: "db-01", failed: true, msg: "real" },
  ]);
  const badge = { slug: env.slug, name: env.name, kind: env.kind, color: env.color };
  const events = store.listEvents(run.id, { cursor: 0, limit: 10_000 });
  const view = buildRunView(store.getRun(run.id)!, badge, events, null, []);
  assert.deepEqual(failedCells(view, events, {}).map((c) => c.host), ["db-01"]);
});
