import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaybook } from "./parser/parse.ts";
import { loadText } from "../test-util.ts";
import { createCli, type CliDeps, type RunFormPayload } from "./cli.ts";
import type { RunSpec } from "../shared/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHostClient, loadLines, memDb } from "../test-util.ts";
import { RunService } from "./runs.ts";
import { Store } from "./store.ts";

const content = loadText("playbooks/site.yml");
const summary = parsePlaybook("lab", "site.yml", content);
const env = { id: "e1", slug: "lab", name: "Lab", kind: "lab", color: "#22c55e", rules: "Check first.", controlHost: "control", hostId: null, repoPath: "/srv/example", inventoryRoot: "/srv/example/inventories", runnerKind: "ssh", agentApproval: "form", defaultCheck: true, infraEnvSlug: null, enabled: true, createdAt: 0 };
const badge = { slug: "lab", name: "Lab", kind: "lab", color: "#22c55e" };
const events = Array.from({ length: 5 }, (_, i) => ({ runId: "run_abc123", seq: i + 1, at: i, kind: i === 2 ? "host_failed" : "task_start", play: "Play", task: `t${i}`, taskAction: null, nodeId: "p0/t0", host: "web-01", changed: false, failed: i === 2, msg: null, res: null, diff: null, stdout: null, source: "text" }));
const runRow = { id: "run_abc123", envId: "e1", playbook: "site.yml", playbookName: "Site", spec: {}, status: "success", source: { surface: "cli", threadId: null, scheduleId: null }, requestedAt: 0, startedAt: 0, endedAt: 1, recap: null, error: null, lastLine: null, logPath: "/tmp/x.log" };
const view = (status: string) => ({ runId: "run_abc123", status, playbook: "site.yml", env: badge, plays: [{ id: "p0", name: "Web", tasks: [] }], hosts: ["web-01"], counters: { ok: 1, changed: 0, failed: 1, unreachable: 0, skipped: 0 }, recap: status === "running" ? null : { "web-01": { ok: 1, changed: 0, failures: 1, unreachable: 0, skipped: 0, rescued: 0, ignored: 0 } }, investigations: [], startedAt: 0, endedAt: 1, lastLine: null });

function setup(over: Partial<CliDeps> & { form?: Awaited<ReturnType<CliDeps["requestRunForm"]>> } = {}) {
  const payloads: RunFormPayload[] = [];
  const started: unknown[] = [];
  let views = 0;
  const deps = {
    envs: { list: () => [env], get: (s: string) => (s === "lab" ? env : null), badge: () => badge, health: () => ({ code: "ok", head: "3f2a1c9" }) },
    library: { summary: async (e: string, p: string) => (e === "lab" && p === "site.yml" ? { summary, content } : { notFound: true }), list: async () => [], discoverInventories: async () => [], resolveInventory: async () => null },
    runs: {
      prepare: async () => ({ allowed: true, confirm: "interaction", phrase: null, summaryLine: "lab site.yml → inv (check)" }),
      start: async (i: unknown) => { started.push(i); return { id: "run_abc123" }; },
      view: async () => view(++views < 2 ? "running" : "failed"),
      cancel: async () => ({ ok: true }),
    },
    store: { getRun: (id: string) => (id === "run_abc123" ? runRow : null), getEnv: () => env, listRuns: () => [runRow], listEvents: (_: string, f: { cursor: number; limit: number }) => events.filter((e) => e.seq > f.cursor).slice(0, f.limit), listCredRefs: () => [], listInvestigations: () => [] },
    host: { call: async () => ({ ok: true, output: "playbook: site.yml" }) },
    hostIdFor: () => "host_1",
    dispatch: null,
    sleep: async () => {},
    requestRunForm: async (_t: string, p: RunFormPayload) => { payloads.push(p); return over.form ?? { outcome: "submitted", value: { ...p.spec, limit: "web-01" } }; },
    ...over,
  } as unknown as CliDeps;
  const cli = createCli(deps);
  return { run: (ctx: { threadId?: string }, ...argv: string[]) => cli.run(argv, ctx), payloads, started };
}

test("show ends with the ::playbook line; --json returns the summary", async () => {
  const { run } = setup();
  const r = await run({}, "show", "lab/site.yml");
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout!.trimEnd().split("\n").at(-1), '::playbook{env="lab" file="site.yml"}');
  const j = JSON.parse((await run({}, "show", "lab/site.yml", "--json")).stdout!);
  assert.equal(j.ok, true);
  assert.equal(j.summary.path, "site.yml");
});

test("context respects --budget", async () => {
  const { run } = setup();
  const r = await run({}, "context", "lab/site.yml#p0/t1", "--budget", "20");
  assert.equal(r.exitCode, 0);
  assert.ok(r.stdout!.trimEnd().split("\n").length <= 20);
  assert.ok(Buffer.byteLength(r.stdout!) <= 200, "budget is bytes: only header and footer survive");
});

test("run in a thread asks the form, starts with the submitted spec, --wait prints the recap", async () => {
  const { run, payloads, started } = setup();
  const r = await run({ threadId: "thr_1" }, "run", "lab/site.yml", "--wait");
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(payloads[0]!.summaryLine, "lab site.yml → inv (check)");
  assert.equal(payloads[0]!.spec.check, true);
  assert.equal((started[0] as { spec: RunSpec }).spec.limit, "web-01");
  assert.match(r.stdout!, /run_abc123/);
  assert.match(r.stdout!, /web-01: ok=1 changed=0 unreachable=0 failed=1/);
});

test("a cancelled form exits 2 with run_cancelled", async () => {
  const { run, started } = setup({ form: { outcome: "cancelled", reason: "user" } });
  const r = await run({ threadId: "thr_1" }, "run", "lab/site.yml", "--json");
  assert.equal(r.exitCode, 2);
  assert.equal(JSON.parse(r.stdout!).error.code, "run_cancelled");
  assert.equal(started.length, 0);
});

test("run without a thread needs --no-confirm", async () => {
  const { run } = setup();
  const r = await run({}, "run", "lab/site.yml", "--json");
  const e = JSON.parse(r.stdout!).error;
  assert.equal(e.code, "confirmation_required");
  assert.match(e.hint, /--no-confirm/);
});

test("--template is not supported yet", async () => {
  const r = await setup().run({}, "run", "lab/site.yml", "--template", "x", "--json");
  assert.equal(JSON.parse(r.stdout!).error.code, "not_supported");
});

test("log pages events and prints nextCursor", async () => {
  const { run } = setup();
  const j = JSON.parse((await run({}, "log", "run_abc123", "--cursor", "0", "--limit", "2", "--json")).stdout!);
  assert.equal(j.events.length, 2);
  assert.equal(j.nextCursor, 2);
  assert.match((await run({}, "log", "run_abc123", "--limit", "2")).stdout!, /nextCursor: 2/);
});

test("unknown targets are not_found with the target shapes", async () => {
  const { run } = setup();
  for (const argv of [["show", "lab/nope.yml"], ["show", "zz/site.yml"], ["context", "not a target"]]) {
    const r = await run({}, ...argv, "--json");
    const e = JSON.parse(r.stdout!).error;
    assert.equal(e.code, "not_found");
    assert.match(e.hint, /<env>\/<path>#<node>/);
  }
});

test("investigate without dispatch is not_supported", async () => {
  const r = await setup().run({}, "investigate", "run_abc123", "--json");
  assert.equal(JSON.parse(r.stdout!).error.code, "not_supported");
});

test("log pages stay within the json byte budget", async () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ ...events[0]!, seq: i + 1, diff: "d".repeat(60_000) }));
  const { run } = setup({ store: { getRun: () => runRow, listEvents: (_: string, f: { cursor: number; limit: number }) => big.filter((e) => e.seq > f.cursor).slice(0, f.limit) } as never });
  const r = await run({}, "log", "run_abc123", "--limit", "30", "--json");
  assert.ok(Buffer.byteLength(r.stdout!) < 700_000);
  const j = JSON.parse(r.stdout!);
  assert.ok(j.events.length < 30 && j.nextCursor === j.events.length);
  const text = (await run({}, "log", "run_abc123", "--limit", "30")).stdout!;
  assert.ok(!text.includes("dddd") && Buffer.byteLength(text) < 20_000);
});

test("log --host --node detail pages stay within the byte budget", async () => {
  const big = Array.from({ length: 200 }, (_, i) => ({ ...events[0]!, seq: i + 1, res: "r".repeat(8000), stdout: "o".repeat(4000) }));
  const { run } = setup({ store: { getRun: () => runRow, listEvents: (_: string, f: { cursor: number; limit: number }) => big.filter((e) => e.seq > f.cursor).slice(0, f.limit) } as never });
  const text = (await run({}, "log", "run_abc123", "--limit", "200", "--host", "web-01", "--node", "p0/t0")).stdout!;
  assert.ok(Buffer.byteLength(text) < 600_000, `page is ${Buffer.byteLength(text)} bytes`);
  assert.match(text, /^res: rrrr/m);
  const m = /nextCursor: (\d+)$/.exec(text.trimEnd());
  assert.ok(m && Number(m[1]) > 0 && Number(m[1]) < 200, "a partial page points at the next event");
  assert.equal(text.split("\n").filter((l) => l.startsWith("#")).length, Number(m![1]));
});

test("log --node and context run/<host>/<node> find events through the persisted node ids", async () => {
  const store = new Store(memDb(), () => 1000);
  const e = store.upsertEnv({ slug: "lab", name: "Lab", kind: "lab", color: "#22c55e", rules: "", controlHost: "control", hostId: null, repoPath: "/srv/example", inventoryRoot: "/srv/example", runnerKind: "ssh", agentApproval: "none", defaultCheck: true, infraEnvSlug: null, enabled: true });
  const host = fakeHostClient({ startRun: async () => ({ pid: 7 }) });
  const runs = new RunService({
    store, host, now: () => 1000, log: () => undefined, resolveEnv: () => ({ env: e, hostId: "host_1" }), credRef: () => null, summaryFor: async () => summary,
    onRunChanged: () => undefined, notifyThread: async () => undefined, logDir: () => mkdtempSync(join(tmpdir(), "playbooks-cli-")),
  });
  const spec: RunSpec = { inventory: "", limit: "", tags: [], skipTags: [], extraVars: {}, credRefId: null, check: true, diff: true, verbosity: 0, branch: null };
  const row = await runs.start({ envId: e.id, playbook: "site.yml", spec, source: { surface: "panel", threadId: null, scheduleId: null }, approval: "none" });
  let seq = 0; for (const line of loadLines("runner_events.jsonl")) runs.onLine({ ident: runs.ident(row.id), seq: ++seq, line });
  const cli = createCli({
    envs: { list: () => [e], get: () => e, badge: () => badge, health: () => null }, library: { summary: async () => ({ summary, content }) }, runs, store, host, hostIdFor: () => "host_1", dispatch: null,
    sleep: async () => {}, requestRunForm: async () => { throw new Error("no form here"); },
  } as unknown as CliDeps);
  const log = await cli.run(["log", row.id, "--node", "p1/t1", "--host", "db-01"], {});
  assert.equal(log.exitCode, 0, log.stderr);
  assert.match(log.stdout!, /host_failed db-01/);
  assert.ok(!log.stdout!.includes("(no events)"));
  const failed = JSON.parse((await cli.run(["log", row.id, "--node", "p1/t1", "--failed", "--json"], {})).stdout!);
  assert.equal(failed.events.length, 1); assert.equal(failed.events[0].nodeId, "p1/t1"); assert.equal(failed.events[0].host, "db-01");
  const ctx = await cli.run(["context", `${row.id}/db-01/p1/t1`], {});
  assert.equal(ctx.exitCode, 0, ctx.stderr);
  assert.match(ctx.stdout!, /failed host: db-01/); assert.match(ctx.stdout!, /node: p1\/t1/); assert.match(ctx.stdout!, /message: /);
});

test("check --json exits 1 when the syntax check fails", async () => {
  const { run } = setup({ host: { call: async () => ({ ok: false, output: "boom" }) } as never });
  assert.equal((await run({}, "check", "lab/site.yml", "--json")).exitCode, 1);
});
