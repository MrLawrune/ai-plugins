import { test } from "node:test";
import assert from "node:assert/strict";
import { rpcContract } from "../schemas.ts";
import { createRpcHandlers, type RpcDeps } from "./rpc.ts";
import type { RunSpec } from "../shared/types.ts";

const env = { id: "env_1", slug: "lab", name: "Lab", kind: "lab", color: "#22c55e", enabled: true };
const spec: RunSpec = { inventory: "", limit: "", tags: [], skipTags: [], extraVars: {}, credRefId: null, check: true, diff: false, verbosity: 0, branch: null };

function harness(over: Partial<RpcDeps> = {}) {
  const started: unknown[] = [];
  const deps = {
    store: { listRuns: () => [], listOpenRuns: () => [] },
    envs: { get: (s: string) => (s === "lab" ? env : null), badge: () => ({ slug: "lab" }), list: () => [env], health: () => null },
    library: {},
    runs: {
      prepare: async () => ({ allowed: true, confirm: "none", phrase: null, summaryLine: "x" }),
      start: async (i: unknown) => { started.push(i); return { id: "run_abc123" }; },
    },
    dispatch: null,
    ...over,
  } as unknown as RpcDeps;
  return { rpc: createRpcHandlers(deps), started };
}

test("playbook.summary for an unknown env is data, not an error", async () => {
  const { rpc } = harness();
  const r = await rpc["playbook.summary"]({ env: "nope", file: "site.yml" });
  assert.equal(r.found, false);
  assert.equal(!r.found && r.reason, "unknown-env");
});

test("run.start returns the run id and passes source.surface through", async () => {
  const { rpc, started } = harness();
  const r = await rpc["run.start"]({ env: "lab", file: "site.yml", spec, source: { surface: "panel", threadId: "thr_1" } });
  assert.deepEqual(r, { runId: "run_abc123" });
  const s = started[0] as { source: { surface: string; threadId: string }; approval: string };
  assert.equal(s.source.surface, "panel");
  assert.equal(s.source.threadId, "thr_1");
  assert.equal(s.approval, "none");
});

test("run.start refuses when policy disallows", async () => {
  const { rpc } = harness({ runs: { prepare: async () => ({ allowed: false, reason: "nope" }) } as unknown as RpcDeps["runs"] });
  await assert.rejects(rpc["run.start"]({ env: "lab", file: "site.yml", spec, source: { surface: "card", threadId: null } }), /nope/);
});

test("dispatch methods throw not_implemented until dispatch is wired", async () => {
  const { rpc } = harness();
  await assert.rejects(rpc["dispatch.prompt"]({ target: "lab", instruction: "x" }), /not_implemented/);
  await assert.rejects(rpc["run.investigate"]({ runId: "run_abc123" }), /not_implemented/);
});

test("contract schemas reject bad input", () => {
  const good = {
    slug: "lab", name: "Lab", kind: "lab", color: "#22c55e", rules: "", controlHost: "control", hostId: null, repoPath: "/srv/example",
    inventoryRoot: "", runnerKind: "ssh", agentApproval: "form", defaultCheck: true, infraEnvSlug: null, enabled: true,
  };
  const save = rpcContract["env.save"].input;
  assert.equal(save.safeParse(good).success, true);
  assert.throws(() => save.parse({ ...good, slug: "Bad" }));
  assert.equal(save.safeParse({ ...good, controlHost: "local" }).success, false);
  assert.equal(save.safeParse({ ...good, repoPath: "srv/x" }).success, false);
  assert.equal(save.safeParse({ ...good, extra: 1 }).success, false);
  const start = rpcContract["run.start"].input;
  const base = { env: "lab", file: "site.yml", spec, source: { surface: "panel", threadId: null } };
  assert.equal(start.safeParse(base).success, true);
  assert.equal(start.safeParse({ ...base, source: { surface: "schedule", threadId: null } }).success, false);
  // Agent surfaces are the CLI's to submit; over RPC they are invalid input.
  assert.equal(start.safeParse({ ...base, source: { surface: "cli", threadId: "thr_1" } }).success, false);
  assert.equal(start.safeParse({ ...base, source: { surface: "tool", threadId: null } }).success, false);
  assert.equal(rpcContract["run.prepare"].input.safeParse({ ...base, source: { surface: "cli", threadId: "thr_1" } }).success, false);
  assert.equal(start.safeParse({ ...base, file: "../x.yml" }).success, false);
  assert.equal(rpcContract["run.view"].input.safeParse({ runId: "bad" }).success, false);
});

test("agentApproval accepts only form or none", () => {
  const save = rpcContract["env.save"].input;
  const good = { slug: "lab", name: "Lab", kind: "lab", color: "#22c55e", rules: "", controlHost: "control", hostId: null, repoPath: "/srv/example", inventoryRoot: "", runnerKind: "ssh", agentApproval: "none", defaultCheck: true, infraEnvSlug: null, enabled: true };
  assert.equal(save.safeParse(good).success, true);
  assert.equal(save.safeParse({ ...good, agentApproval: "always" }).success, false);
});

test("run.start and run.prepare refuse a client-claimed agent surface even past the schema", async () => {
  const { rpc, started } = harness();
  for (const surface of ["cli", "tool", "schedule"]) {
    await assert.rejects(rpc["run.start"]({ env: "lab", file: "site.yml", spec, source: { surface: surface as "panel", threadId: null } }), /invalid_input: source\.surface/);
    await assert.rejects(rpc["run.prepare"]({ env: "lab", file: "site.yml", spec, source: { surface: surface as "panel", threadId: null } }), /invalid_input/);
  }
  assert.equal(started.length, 0);
});

test("run.events pages by bytes and reports nextCursor", async () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ runId: "run_abc123", seq: i + 1, at: i, kind: "host_ok", play: "P", task: "T", taskAction: null, nodeId: "p0/t0", host: "web-01", changed: false, failed: false, msg: null, res: null, diff: "d".repeat(60_000), stdout: null, source: "text" }));
  const { rpc } = harness({ store: { listEvents: (_: string, f: { cursor: number; limit: number }) => big.filter((e) => e.seq > f.cursor).slice(0, f.limit) } as unknown as RpcDeps["store"] });
  const page = await rpc["run.events"]({ runId: "run_abc123", cursor: 0, limit: 1000 });
  assert.ok(page.events.length > 0 && page.events.length < 30);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 600_000);
  assert.equal(page.nextCursor, page.events.length); assert.equal(page.cursor, page.events.length);
  const rest = await rpc["run.events"]({ runId: "run_abc123", cursor: 22, limit: 1000 });
  assert.equal(rest.events.length, 8); assert.equal(rest.nextCursor, null); assert.equal(rest.cursor, 30);
  // A full page at the limit also points at the next one; an empty page keeps the cursor.
  const full = await rpc["run.events"]({ runId: "run_abc123", cursor: 0, limit: 2 });
  assert.equal(full.nextCursor, 2);
  assert.deepEqual(await rpc["run.events"]({ runId: "run_abc123", cursor: 30, limit: 10 }), { events: [], cursor: 30, nextCursor: null });
  // light drops the heavy columns, so the whole set fits one page (what the run view's failure list asks for).
  const lite = await rpc["run.events"]({ runId: "run_abc123", cursor: 0, limit: 1000, light: true });
  assert.equal(lite.events.length, 30); assert.equal(lite.nextCursor, null);
  assert.ok(lite.events.every((e) => e.res === null && e.diff === null && e.stdout === null && e.msg === null && e.nodeId === "p0/t0"));
  assert.equal(rpcContract["run.events"].input.safeParse({ runId: "run_abc123", cursor: 0, limit: 10, light: true }).success, true);
});

test("run.start forwards the typed phrase", async () => {
  const { rpc, started } = harness();
  await rpc["run.start"]({ env: "lab", file: "site.yml", spec, source: { surface: "page", threadId: null }, typed: "lab" });
  assert.equal((started[0] as { typed: string }).typed, "lab");
});

test("run.raw returns a slice and the bytes actually read", async () => {
  const { rpc } = harness({
    store: { getRun: () => ({ logPath: "/tmp/x.log" }) } as unknown as RpcDeps["store"],
    readLog: async (_p: string, offset: number, bytes: number) => ({ text: "héllo world".slice(offset, offset + bytes), size: 12 }),
  });
  assert.deepEqual(await rpc["run.raw"]({ runId: "run_abc123", offset: 0, bytes: 2 }), { text: "hé", offset: 0, size: 12, read: 3 });
});

test("runs.list forwards the thread filter to the store", async () => {
  let seen: unknown = null;
  const { rpc } = harness({ store: { listRuns: (f: unknown) => { seen = f; return []; }, listOpenRuns: () => [] } as unknown as RpcDeps["store"] });
  await rpc["runs.list"]({ threadId: "thr_1", limit: 50 });
  assert.deepEqual(seen, { threadId: "thr_1", limit: 50 });
  assert.equal(rpcContract["runs.list"].input.safeParse({ threadId: "thr_1", limit: 5 }).success, true);
});

test("run.view carries the run's spec so the UI can rerun and label it", async () => {
  const view = { runId: "run_abc123" };
  const { rpc } = harness({
    runs: { view: async () => view } as unknown as RpcDeps["runs"],
    store: { getRun: () => ({ spec }), listRuns: () => [], listOpenRuns: () => [] } as unknown as RpcDeps["store"],
  });
  assert.deepEqual(await rpc["run.view"]({ runId: "run_abc123" }), { found: true, view, spec });
});

type Ev = { seq: number; at: number; kind: string; host: string | null; play: string | null; task: string | null; nodeId: null; msg?: string };
const ev = (seq: number, kind: string, play: string | null, task: string | null, host: string | null = null, msg?: string): Ev => ({ seq, at: 1000 + seq * 100, kind, host, play, task, nodeId: null, ...(msg ? { msg } : {}) });
const cellHarness = (events: Ev[], plays: { id: string; name: string; tasks: { nodeId: string | null; name: string; cells: object }[] }[]) =>
  harness({
    runs: { view: async () => ({ plays }) } as unknown as RpcDeps["runs"],
    store: { listEvents: () => events } as unknown as RpcDeps["store"],
  }).rpc;

test("run.cell separates same-named tasks in one play by ordinal", async () => {
  const events = [
    ev(1, "play_start", "Web", null),
    ev(2, "task_start", "Web", "Install packages"), ev(3, "host_ok", "Web", "Install packages", "web-01", "first"),
    ev(4, "task_start", "Web", "Install packages"), ev(5, "host_failed", "Web", "Install packages", "web-01", "second"),
  ];
  const rpc = cellHarness(events, [{ id: "p0", name: "Web", tasks: [{ nodeId: "p0/t0", name: "Install packages", cells: {} }, { nodeId: "p0/t1", name: "Install packages", cells: {} }] }]);
  assert.equal((await rpc["run.cell"]({ runId: "run_abc123", host: "web-01", node: "p0/t0" })).msg, "first");
  assert.equal((await rpc["run.cell"]({ runId: "run_abc123", host: "web-01", node: "p0/t1" })).msg, "second");
  assert.equal((await rpc["run.cell"]({ runId: "run_abc123", host: "web-01", node: "p0/t0", playIndex: 0, taskIndex: 1 })).msg, "second");
});

test("run.cell separates same-named plays by ordinal and times from the row's own task_start", async () => {
  const events = [
    ev(1, "play_start", "Deploy", null), ev(2, "task_start", "Deploy", "Copy"), ev(3, "host_ok", "Deploy", "Copy", "web-01", "one"),
    ev(4, "play_start", "Deploy", null), ev(5, "task_start", "Deploy", "Copy"), ev(6, "host_failed", "Deploy", "Copy", "web-01", "two"),
  ];
  const rpc = cellHarness(events, [
    { id: "p0", name: "Deploy", tasks: [{ nodeId: "p0/t0", name: "Copy", cells: {} }] },
    { id: "p0", name: "Deploy", tasks: [{ nodeId: "p1/t0", name: "Copy", cells: {} }] },
  ]);
  assert.deepEqual(await rpc["run.cell"]({ runId: "run_abc123", host: "web-01", node: "p0/t0" }), { msg: "one", res: null, diff: null, stdout: null, durationMs: 100, ignored: false });
  assert.equal((await rpc["run.cell"]({ runId: "run_abc123", host: "web-01", node: "p1/t0" })).msg, "two");
});

test("run.cell for a host with no result in the row is empty", async () => {
  const rpc = cellHarness([ev(1, "play_start", "Web", null), ev(2, "task_start", "Web", "Enable")], [{ id: "p0", name: "Web", tasks: [{ nodeId: "p0/t0", name: "Enable", cells: {} }] }]);
  assert.equal((await rpc["run.cell"]({ runId: "run_abc123", host: "db-01", node: "p0/t0" })).msg, null);
});

test("env.test returns the full EnvHealth object for a degraded probe", async () => {
  const health = { code: "degraded", message: "The repo is not a git checkout; HEAD is unknown.", ansible: "core 2.19", runner: "2.4.0", python3: "3.13", head: null, playbooks: 2 };
  const { rpc } = harness({ envs: { test: async () => health } as unknown as RpcDeps["envs"] });
  assert.deepEqual(await rpc["env.test"]({ id: "env_1" }), { health });
});

test("runs.list carries host counts from the recap and null without one", async () => {
  const stats = { ok: 1, changed: 0, failures: 0, unreachable: 0, skipped: 0, rescued: 0, ignored: 0 };
  const row = (id: string, recap: unknown) => ({ id, envId: "env_1", playbook: "site.yml", playbookName: "Site", status: "failed", requestedAt: 1, startedAt: 1, endedAt: 2, source: { surface: "cli", threadId: null, scheduleId: null }, spec, lastLine: '{"x":1}', recap });
  const rows = [
    row("run_aaaaaa", { "web-01": { ...stats, changed: 2 }, "web-02": stats, "db-01": { ...stats, failures: 1 }, "gone": { ...stats, unreachable: 1 } }),
    row("run_bbbbbb", null),
  ];
  const { rpc } = harness({ store: { listRuns: () => rows, listOpenRuns: () => [], getEnv: () => env } as unknown as RpcDeps["store"] });
  const { runs } = await rpc["runs.list"]({ limit: 5 });
  assert.deepEqual([runs[0]!.hosts, runs[0]!.failedHosts, runs[0]!.changedHosts], [4, 2, 1]);
  assert.deepEqual([runs[1]!.hosts, runs[1]!.failedHosts, runs[1]!.changedHosts], [null, null, null]);
});

test("run.cell flags an ignored failure", async () => {
  const base = { at: 1, play: "P", task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false, msg: null, res: null, diff: null, stdout: null, source: "events" };
  const events = [{ ...base, kind: "task_start", task: "Enable" }, { ...base, kind: "host_failed", task: "Enable", host: "web-01", failed: false, msg: "unit missing" }, { ...base, kind: "host_failed", task: "Enable", host: "db-01", failed: true, msg: "real" }];
  const { rpc } = harness({
    runs: { view: async () => null } as unknown as RpcDeps["runs"],
    store: { listEvents: () => events } as unknown as RpcDeps["store"],
  });
  const cell = (host: string) => rpc["run.cell"]({ runId: "run_abc123", host, node: "p0/t0", playIndex: 0, taskIndex: 0 });
  assert.equal((await cell("web-01")).ignored, true);
  assert.equal((await cell("db-01")).ignored, false);
});
