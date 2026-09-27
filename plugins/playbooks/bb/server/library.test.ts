import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeHostClient, loadText, memDb } from "../test-util.ts";
import { Store } from "./store.ts";
import { LibraryService } from "./library.ts";

const site = loadText("playbooks/site.yml");
const vars = "nginx_port: 80\nsite_domain: www.example.com\n";
const setup = () => {
  let clock = 1000;
  const files: Record<string, string> = { "site.yml": site, "group_vars/all.yml": vars };
  const store = new Store(memDb(), () => clock);
  const env = store.upsertEnv({ slug: "lab", name: "Lab", kind: "lab", color: "#0f0", rules: "", controlHost: "control", hostId: null, repoPath: "/srv/example", inventoryRoot: "/srv/example/inventories", runnerKind: "ssh", agentApproval: "form", defaultCheck: true, infraEnvSlug: null, enabled: true });
  const host = fakeHostClient({
    readFile: async (i) => {
      const c = files[i.path];
      if (c === undefined) throw new Error("not_found: " + i.path);
      return { content: c, hash: String(c.length), bytes: c.length };
    },
    listPlaybooks: async () => ({ paths: Object.keys(files) }),
    // group_vars is pruned from the listing, as on a real control host; hashes match the readFile fake's.
    hashPlaybooks: async () => ({ files: Object.entries(files).filter(([p]) => !p.startsWith("group_vars/")).map(([path, c]) => ({ path, hash: String(c.length), bytes: c.length })) }),
    discoverInventories: async () => ({ entries: [{ path: "prod.ini", kind: "file" }, { path: "staging", kind: "directory" }] }),
    resolveInventory: async () => ({ json: JSON.stringify({ _meta: { hostvars: { "web-01": {} } }, all: { children: ["web"] }, web: { hosts: ["web-01"] } }) }),
  });
  const published: { envId: string; paths: string[] }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const warnings: string[] = [];
  const svc = new LibraryService({ store, host, now: () => clock, resolveEnv: (slug) => { const e = store.getEnvBySlug(slug); return e ? { env: e, hostId: "host_1" } : null; }, publishChanged: (p) => published.push(p), log: (_l, m) => warnings.push(m), setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return { clear: () => { t.cleared = true; } }; } });
  return { store, env, host, svc, files, published, timers, warnings, tick: (ms: number) => { clock += ms; } };
};

test("summary parses, caches for 5 s, and force bypasses the cache", async () => {
  const s = setup();
  const r = await s.svc.summary("lab", "site.yml");
  assert.ok("summary" in r && r.summary.counts.plays === 2 && r.content === site);
  await s.svc.summary("lab", "site.yml");
  assert.equal(s.host.calls.length, 1);
  await s.svc.summary("lab", "site.yml", { force: true });
  assert.equal(s.host.calls.length, 2);
  s.tick(5001);
  await s.svc.summary("lab", "site.yml");
  assert.equal(s.host.calls.length, 3);
});

test("summary: missing file, unsafe path, unreachable host", async () => {
  const s = setup();
  assert.deepEqual(await s.svc.summary("lab", "nope.yml"), { notFound: true });
  assert.deepEqual(await s.svc.summary("lab", "../etc/passwd"), { notFound: true });
  assert.deepEqual(await s.svc.summary("lab", "/etc/passwd"), { notFound: true });
  assert.deepEqual(await s.svc.summary("nope", "site.yml"), { notFound: true });
  s.host.script.readFile = async () => { throw new Error("ssh: timeout"); };
  const r = await s.svc.summary("lab", "site.yml", { force: true });
  assert.ok("unreachable" in r && /timeout/.test(r.unreachable));
});

test("onThreadActivity publishes only when the hash changed, throttled per thread", async () => {
  const s = setup();
  await s.svc.summary("lab", "site.yml", { threadId: "thr_1" });
  assert.deepEqual(s.svc.threadFiles("thr_1").map((f) => f.path), ["site.yml"]);
  await s.svc.onThreadActivity("thr_1");
  assert.deepEqual(s.published, []);
  s.files["site.yml"] = site + "\n# edited\n";
  await s.svc.onThreadActivity("thr_1"); // throttled: same second
  assert.deepEqual(s.published, []);
  s.tick(1001);
  await s.svc.onThreadActivity("thr_1");
  assert.deepEqual(s.published, [{ envId: s.env.id, paths: ["site.yml"] }]);
  s.tick(1001);
  await s.svc.onThreadActivity("thr_1");
  assert.equal(s.published.length, 1);
});

test("list excludes non-playbook YAML", async () => {
  const s = setup();
  s.files["notes.yml"] = "just: data\n";
  const l = await s.svc.list("lab");
  assert.deepEqual(l.map((x) => x.path), ["site.yml"]);
  assert.equal(l[0]?.counts.plays, 2);
  assert.equal(l[0]?.lastRun, null);
});

test("list takes one hash listing per call and reads only files whose hash is not cached", async () => {
  const s = setup();
  s.files["web.yml"] = site;
  const methods = () => s.host.calls.map((c) => c.method);
  await s.svc.list("lab");
  assert.deepEqual(methods(), ["hashPlaybooks", "readFile", "readFile"]);
  s.host.calls.length = 0;
  s.tick(60_000); // well past the summary TTL: the listing, not the clock, decides what is re-read
  assert.deepEqual((await s.svc.list("lab")).map((x) => x.path), ["site.yml", "web.yml"]);
  assert.deepEqual(methods(), ["hashPlaybooks"]);
  s.host.calls.length = 0;
  s.files["web.yml"] = site + "\n# edited\n";
  await s.svc.list("lab");
  assert.deepEqual(s.host.calls.map((c) => [c.method, (c.input as { path?: string }).path]), [["hashPlaybooks", undefined], ["readFile", "web.yml"]]);
  assert.deepEqual(s.published, [{ envId: s.env.id, paths: ["web.yml"] }]);
  // A confirmed hash counts as fresh for summary() too.
  s.host.calls.length = 0;
  await s.svc.summary("lab", "site.yml");
  assert.deepEqual(methods(), []);
  // Files over the read limit are listed but never fetched.
  s.host.script.hashPlaybooks = async () => ({ files: [{ path: "huge.yml", hash: "x", bytes: 2_000_000 }] });
  s.host.calls.length = 0;
  assert.deepEqual(await s.svc.list("lab"), []);
  assert.deepEqual(methods(), ["hashPlaybooks"]);
});

test("onThreadActivity lists hashes once per environment and reads only changed or unlisted files", async () => {
  const s = setup();
  await s.svc.summary("lab", "site.yml", { threadId: "thr_1" });
  await s.svc.summary("lab", "group_vars/all.yml", { threadId: "thr_1" });
  s.host.calls.length = 0;
  s.tick(1001);
  await s.svc.onThreadActivity("thr_1");
  // site.yml is listed and unchanged (skipped); group_vars is outside the listing, so it is read directly.
  assert.deepEqual(s.host.calls.map((c) => [c.method, (c.input as { path?: string }).path]), [["hashPlaybooks", undefined], ["readFile", "group_vars/all.yml"]]);
  assert.deepEqual(s.published, []);
  s.host.calls.length = 0;
  s.tick(1001);
  s.files["site.yml"] = site + "\n# edited\n";
  await s.svc.onThreadActivity("thr_1");
  assert.deepEqual(s.host.calls.map((c) => [c.method, (c.input as { path?: string }).path]).sort(), [["hashPlaybooks", undefined], ["readFile", "group_vars/all.yml"], ["readFile", "site.yml"]]);
  assert.deepEqual(s.published, [{ envId: s.env.id, paths: ["site.yml"] }]);
  // A failed listing falls back to reading every touched file.
  s.host.calls.length = 0;
  s.tick(1001);
  s.host.script.hashPlaybooks = async () => { throw new Error("ssh: timeout"); };
  await s.svc.onThreadActivity("thr_1");
  assert.deepEqual(s.host.calls.map((c) => c.method), ["hashPlaybooks", "readFile", "readFile"]);
  assert.equal(s.published.length, 1);
});

test("discoverInventories stores repo-relative paths and resolveInventory persists through the store", async () => {
  const s = setup();
  const inv = await s.svc.discoverInventories("lab");
  assert.deepEqual(inv.map((i) => [i.path, i.kind, i.name]), [["inventories/prod.ini", "file", "prod.ini"], ["inventories/staging", "directory", "staging"]]);
  assert.deepEqual(s.host.calls.at(-1)!.input, { controlHost: "control", inventoryRoot: "/srv/example/inventories" });
  const r = await s.svc.resolveInventory("lab", "inventories/prod.ini");
  assert.ok(r && r.groups.includes("web") && r.hosts.includes("web-01"));
  assert.ok(s.store.listInventories(s.env.id)[0]?.groups);
});

test("discoverInventories with the repository as inventory root keeps paths as listed; an outside root is refused", async () => {
  const s = setup();
  s.store.upsertEnv({ ...s.env, inventoryRoot: "/srv/example" });
  assert.deepEqual((await s.svc.discoverInventories("lab")).map((i) => i.path), ["prod.ini", "staging"]);
  s.store.upsertEnv({ ...s.env, inventoryRoot: "/srv/elsewhere" });
  await assert.rejects(s.svc.discoverInventories("lab"), /outside the repository/);
});

test("a call inside the throttle window schedules one trailing re-check", async () => {
  const s = setup();
  await s.svc.summary("lab", "site.yml", { threadId: "thr_1" });
  const base = s.host.calls.length;
  await s.svc.onThreadActivity("thr_1");
  assert.equal(s.host.calls.length, base + 1);
  s.tick(100);
  s.files["site.yml"] = site + "\n# late edit\n";
  await s.svc.onThreadActivity("thr_1");
  await s.svc.onThreadActivity("thr_1");
  assert.equal(s.host.calls.length, base + 1);
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0]?.ms, 900);
  s.tick(900);
  s.timers[0]?.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.host.calls.length, base + 3, "the trailing re-check lists hashes once and reads the changed file");
  assert.deepEqual(s.published, [{ envId: s.env.id, paths: ["site.yml"] }]);
});

test("dispose clears the pending re-check", async () => {
  const s = setup();
  await s.svc.summary("lab", "site.yml", { threadId: "thr_1" });
  await s.svc.onThreadActivity("thr_1");
  await s.svc.onThreadActivity("thr_1");
  s.svc.dispose();
  assert.equal(s.timers[0]?.cleared, true);
});

test("a thread file without a baseline is seeded silently, then publishes on the next difference", async () => {
  const s = setup();
  s.store.touchThreadFile("thr_2", s.env.id, "site.yml");
  await s.svc.onThreadActivity("thr_2");
  assert.deepEqual(s.published, []);
  s.tick(1001);
  s.files["site.yml"] = site + "\n# x\n";
  await s.svc.onThreadActivity("thr_2");
  assert.deepEqual(s.published, [{ envId: s.env.id, paths: ["site.yml"] }]);
});

test("a forced summary that sees a new hash publishes", async () => {
  const s = setup();
  await s.svc.summary("lab", "site.yml");
  await s.svc.summary("lab", "site.yml", { force: true });
  assert.deepEqual(s.published, []);
  s.files["site.yml"] = site + "\n# y\n";
  await s.svc.summary("lab", "site.yml", { force: true });
  assert.deepEqual(s.published, [{ envId: s.env.id, paths: ["site.yml"] }]);
});

test("summary does not record a thread file that does not exist", async () => {
  const s = setup();
  await s.svc.summary("lab", "nope.yml", { threadId: "thr_3" });
  assert.deepEqual(s.svc.threadFiles("thr_3"), []);
});

test("resolveInventory survives non-JSON and collects hosts from group arrays", async () => {
  const s = setup();
  s.host.script.resolveInventory = async () => ({ json: "not json" });
  assert.deepEqual(await s.svc.resolveInventory("lab", "inv.ini"), { groups: [], hosts: [] });
  assert.equal(s.warnings.length, 1);
  s.host.script.resolveInventory = async () => ({ json: JSON.stringify({ web: { hosts: ["web-02"] } }) });
  assert.deepEqual((await s.svc.resolveInventory("lab", "inv.ini"))?.hosts, ["web-02"]);
});
