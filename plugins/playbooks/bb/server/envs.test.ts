import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeHostClient, memDb } from "../test-util.ts";
import { Store, type EnvInput } from "./store.ts";
import { EnvService, configurationGap, inventoryPrefix, type EnvHealth } from "./envs.ts";

const input = (over: Partial<EnvInput> = {}): EnvInput => ({
  slug: "lab", name: "Lab", kind: "lab", color: "#22c55e", rules: "", controlHost: "control", hostId: null, repoPath: "/srv/example",
  inventoryRoot: "/srv/example/inventories", runnerKind: "ssh", agentApproval: "form", defaultCheck: true, infraEnvSlug: null, enabled: true, ...over,
});
const probeOk = { ok: true, ansible: "ansible [core 2.19.0]", runner: "2.4.0", head: "3f2a1c9", python3: "/usr/bin/python3", error: null };
const setup = (script: Parameters<typeof fakeHostClient>[0]) => {
  const store = new Store(memDb(), () => 1);
  const host = fakeHostClient(script);
  const svc = new EnvService({ store, host, now: () => 1, primaryHostId: "host_1" });
  return { store, host, svc };
};
const health = (over: Partial<EnvHealth>): EnvHealth => ({ code: "ok", message: null, ansible: null, runner: null, python3: null, head: null, playbooks: 0, ...over });

test("configurationGap: no envs, broken env, healthy env", () => {
  assert.equal(configurationGap([], new Map()), "Add an environment in Settings → Plugins → Playbooks → Environments.");
  const { svc } = setup({});
  const env = svc.save(input());
  assert.equal(configurationGap([env], new Map([[env.id, health({ code: "unreachable" })]])), "Fix the connection for Lab in Settings → Plugins → Playbooks → Environments.");
  assert.equal(configurationGap([env], new Map([[env.id, health({ code: "ok" })]])), null);
});

test("test() reports ok with playbook count", async () => {
  const { svc, host } = setup({ probe: async () => probeOk, listPlaybooks: async () => ({ paths: ["site.yml", "db.yml"] }) });
  const env = svc.save(input());
  const h = await svc.test(env.id);
  assert.deepEqual(h, { code: "ok", message: null, ansible: "ansible [core 2.19.0]", runner: "2.4.0", python3: "/usr/bin/python3", head: "3f2a1c9", playbooks: 2 });
  assert.equal(svc.health(env.id), h);
  assert.deepEqual(host.calls[0]?.input, { controlHost: "control", repoPath: "/srv/example" });
});

test("test() maps missing ansible, missing python3, and thrown errors", async () => {
  const s = setup({ probe: async () => ({ ...probeOk, ok: false, ansible: null }) });
  const env = s.svc.save(input());
  assert.equal((await s.svc.test(env.id)).code, "no-ansible");
  s.host.script.probe = async () => ({ ...probeOk, ok: false, python3: null });
  const py = await s.svc.test(env.id);
  assert.equal(py.code, "no-ansible");
  assert.match(py.message ?? "", /python3/);
  s.host.script.probe = async () => { throw new Error("ssh: connect refused"); };
  const bad = await s.svc.test(env.id);
  assert.equal(bad.code, "unreachable");
  assert.match(bad.message ?? "", /connect refused/);
});

test("test() flags a missing repo and a disabled env", async () => {
  const s = setup({ probe: async () => ({ ...probeOk, head: null }), listPlaybooks: async () => { throw new Error("no such directory"); } });
  const env = s.svc.save(input());
  assert.equal((await s.svc.test(env.id)).code, "no-repo");
  const off = s.svc.save(input({ slug: "off", name: "Off", enabled: false }));
  assert.equal((await s.svc.test(off.id)).code, "disabled");
});

test("inventoryPrefix: repo itself, a folder inside, and folders outside", () => {
  assert.equal(inventoryPrefix("/srv/example", ""), "");
  assert.equal(inventoryPrefix("/srv/example", "/srv/example"), "");
  assert.equal(inventoryPrefix("/srv/example/", "/srv/example/inventories/"), "inventories");
  assert.equal(inventoryPrefix("/srv/example", "/srv/example/inv/../inventories/prod"), "inventories/prod");
  assert.equal(inventoryPrefix("/srv/example", "/srv/example2"), null);
  assert.equal(inventoryPrefix("/srv/example", "/srv"), null);
  assert.equal(inventoryPrefix("/srv/example", "/srv/example/../other"), null);
});

test("save defaults an empty inventory folder to the repository and refuses one outside it", () => {
  const { svc } = setup({});
  const env = svc.save(input({ inventoryRoot: "" }));
  assert.equal(env.inventoryRoot, "/srv/example");
  assert.equal(svc.save(input({ id: env.id, inventoryRoot: "  " })).inventoryRoot, "/srv/example");
  assert.equal(svc.save(input({ id: env.id, inventoryRoot: "/srv/example/inventories" })).inventoryRoot, "/srv/example/inventories");
  assert.throws(() => svc.save(input({ id: env.id, inventoryRoot: "/etc/elsewhere" })), /inside the repository/);
});

test("delete refuses while the environment has open runs and keeps finished runs", () => {
  const { svc, store } = setup({});
  const env = svc.save(input());
  const spec = { inventory: "", limit: "", tags: [], skipTags: [], extraVars: {}, credRefId: null, check: true, diff: true, verbosity: 0 as const, branch: null };
  const run = store.insertRun({ envId: env.id, runnerKind: "ssh", playbook: "site.yml", playbookName: "Site", playbookHash: null, templateId: null, spec, source: { surface: "panel", threadId: null, scheduleId: null }, approval: "none" });
  store.updateRun(run.id, { status: "running" });
  assert.throws(() => svc.delete(env.id), /1 open run; wait for or cancel it first/);
  assert.equal(svc.get("lab")?.id, env.id);
  store.updateRun(run.id, { status: "success" });
  svc.delete(env.id);
  assert.equal(svc.get("lab"), null);
  assert.equal(store.getRun(run.id)?.status, "success");
});

test("save rejects the local control host; get resolves id or slug; delete drops health", async () => {
  const { svc } = setup({ probe: async () => probeOk, listPlaybooks: async () => ({ paths: [] }) });
  assert.throws(() => svc.save(input({ controlHost: "local" })), /local/);
  const env = svc.save(input());
  assert.equal(svc.get("lab")?.id, env.id);
  assert.equal(svc.get(env.id)?.slug, "lab");
  await svc.test(env.id);
  svc.delete(env.id);
  assert.equal(svc.get("lab"), null);
  assert.equal(svc.health(env.id), null);
  assert.deepEqual(svc.badge(env), { slug: "lab", name: "Lab", kind: "lab", color: "#22c55e" });
});
