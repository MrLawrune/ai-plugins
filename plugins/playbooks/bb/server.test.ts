import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Store, type SqlDb } from "./server/store.ts";
import plugin, { timing } from "./server.ts";

const sdk = { system: { config: async () => ({ primaryHostId: "host_primary" }) } };

test("unconfigured plugin reports needs-configuration and serves rpc", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "playbooks",
    sdk,
    experimental_callHostRpc: async () => ({ ok: true, ansible: null, runner: null, head: null, error: null }),
  });
  await plugin(bb);
  assert.match(harness.needsConfigurationMessages[0] ?? "", /Add an environment/);
  const r = await harness.behavior.callRpc("overview", {});
  assert.deepEqual(r, { envs: [] });
  await harness.lifecycle.dispose();
});

test("cli registered with all phase-1 commands", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "playbooks", sdk, experimental_callHostRpc: async () => ({}) });
  await plugin(bb);
  const out = await harness.behavior.runCli(["--help"]);
  for (const c of ["envs", "context", "show", "check", "run", "status", "log", "cancel", "runs", "investigate"]) assert.ok(out.stdout.includes(c), c);
  await harness.lifecycle.dispose();
});

const seedEnv = (store: Store) => store.upsertEnv({ slug: "lab", name: "Lab", kind: "lab", color: "#22c55e", rules: "", controlHost: "control-01", hostId: null, repoPath: "/srv/example", inventoryRoot: "/srv/example/inventories", runnerKind: "ssh", agentApproval: "form", defaultCheck: true, infraEnvSlug: null, enabled: true });
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); };

test("background service retries the primary host lookup, then resumes open runs on a later tick", async () => {
  timing.reconcileMs = 10;
  let configCalls = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "playbooks",
    sdk: { system: { config: async () => { if (configCalls++ === 0) throw new Error("not bound yet"); return { primaryHostId: "host_primary" }; } } },
    experimental_callHostRpc: async ({ method }) => (method === "runStatus" ? { status: "successful", rc: 0, lines: 0, alive: false } : {}),
  });
  await plugin(bb);
  const store = new Store(bb.storage.database() as unknown as SqlDb);
  const env = seedEnv(store);
  const run = store.insertRun({ envId: env.id, runnerKind: "ssh", playbook: "site.yml", playbookName: "Site", playbookHash: null, templateId: null, spec: { inventory: "hosts", limit: null, tags: [], skipTags: [], extraVars: {}, check: true, diff: false, verbosity: 0, credRefId: null } as never, source: { surface: "cli", threadId: null, scheduleId: null }, approval: "check" });
  store.updateRun(run.id, { status: "running", externalId: "abc123" });
  const svc = harness.runService("runs");
  await until(() => store.getRun(run.id)?.status === "success");
  assert.equal(store.getRun(run.id)?.status, "success");
  assert.ok(configCalls >= 2, "config was retried");
  assert.ok(harness.inspection.experimental_hostRpcCalls.every((c) => c.hostId === "host_primary"));
  svc.controller.abort();
  await svc.done;
  timing.reconcileMs = 30_000;
  await harness.lifecycle.dispose();
});

test("a cli command that reaches the host works before any rpc call", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "playbooks",
    sdk,
    experimental_callHostRpc: async ({ method }) => (method === "readFile" ? { content: "- hosts: all\n  tasks:\n    - name: ping\n      ping:\n", hash: "h", bytes: 40 } : {}),
  });
  await plugin(bb);
  seedEnv(new Store(bb.storage.database() as unknown as SqlDb));
  const out = await harness.behavior.runCli(["show", "lab/site.yml"]);
  assert.equal(out.exitCode, 0, out.stderr);
  assert.ok(harness.inspection.experimental_hostRpcCalls.some((c) => c.method === "readFile" && c.hostId === "host_primary"));
  await harness.lifecycle.dispose();
});

test("host inputs reaching the host entry never carry overrideCommand", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "playbooks", sdk, experimental_callHostRpc: async () => ({ ok: true, ansible: "2.17", runner: null, head: "abc", python3: "/usr/bin/python3", error: null, paths: [] }) });
  await plugin(bb);
  const env = seedEnv(new Store(bb.storage.database() as unknown as SqlDb));
  await harness.behavior.callRpc("env.test", { id: env.id });
  const calls = harness.inspection.experimental_hostRpcCalls;
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.ok(!("overrideCommand" in (c.input as object)), c.method);
  await harness.lifecycle.dispose();
});
