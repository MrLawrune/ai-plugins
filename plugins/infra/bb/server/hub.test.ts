import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeProvider, guest, host, inv, memDb } from "../test-util.ts";
import { Hub, type ChangeEvent } from "./hub.ts";
import { PveError } from "./providers/proxmox/client.ts";
import type { InfraProvider } from "./providers/types.ts";
import { Store } from "./store.ts";

const sig = new AbortController().signal;

function setup(providers: Record<string, InfraProvider>, labels: string[] = ["a", "b"]) {
  let t = 1000;
  const store = new Store(memDb(), () => t);
  const env = store.upsertEnv({ slug: "homelab", name: "Homelab", kind: "lab", color: "#0f0", pollSeconds: 10, rules: "", exportDir: "" });
  const conns = labels.map((label) => store.upsertConnection({ envId: env.id, label, baseUrl: `https://${label}:8006`, authKind: "token", username: "u@pve!t", tlsMode: "insecure", tlsFingerprint: "", caPem: "", enabled: true }));
  const events: ChangeEvent[] = [];
  const snaps: string[] = [];
  const hub = new Hub({
    store,
    providerFor: async (c) => { const p = providers[c.label]; if (!p) throw new PveError("auth-failed", "no credential saved", null); return p; },
    now: () => t,
    onChange: (e) => events.push(...e),
    onSnapshot: (id) => snaps.push(id),
    log: () => undefined,
  });
  return { hub, store, env, conns, events, snaps, advance: (ms: number) => { t += ms; } };
}

test("merges connections into one env snapshot with host and guest counts", async () => {
  const { hub, conns } = setup({ a: fakeProvider([inv([host("pve1", { ip: "192.0.2.10" })], [guest("pve1", 201)])]), b: fakeProvider([inv([host("pve2")], [guest("pve2", 300)])]) });
  await hub.reload();
  for (const c of conns) await hub.tick(c.id, sig);
  const s = hub.snapshot("homelab")!;
  assert.deepEqual(s.hosts.map((h) => h.node), ["pve1", "pve2"]);
  assert.deepEqual(s.guests.map((g) => [g.node, g.vmid, g.connectionId]), [["pve1", 201, conns[0]!.id], ["pve2", 300, conns[1]!.id]]);
  assert.deepEqual(s.connections.map((c) => c.health.code), ["ok", "ok"]);
  assert.equal(hub.connectionForNode("homelab", "pve1"), conns[0]!.id);
});

test("a failing connection keeps its last snapshot, is marked stale, and others still update", async () => {
  const { hub, conns, advance } = setup({
    a: fakeProvider([inv([host("pve1")], [guest("pve1", 201)]), new PveError("unreachable", "connect ECONNREFUSED", null)]),
    b: fakeProvider([inv([host("pve2")]), inv([host("pve2")], [guest("pve2", 301)])]),
  });
  await hub.reload();
  await hub.tick(conns[0]!.id, sig); await hub.tick(conns[1]!.id, sig);
  advance(10_000);
  await hub.tick(conns[0]!.id, sig); await hub.tick(conns[1]!.id, sig);
  const s = hub.snapshot("homelab")!;
  assert.ok(s.guests.some((g) => g.vmid === 201), "stale guests kept");
  assert.ok(s.guests.some((g) => g.vmid === 301), "healthy connection updated");
  const a = s.connections.find((c) => c.id === conns[0]!.id)!.health;
  assert.deepEqual([a.code, a.staleSince, a.lastOkAt, a.message], ["unreachable", 11_000, 1000, "connect ECONNREFUSED"]);
});

test("duplicate node names across connections degrade the later connection", async () => {
  const { hub, conns } = setup({ a: fakeProvider([inv([host("pve")], [guest("pve", 100)])]), b: fakeProvider([inv([host("PVE")], [guest("PVE", 999)])]) });
  await hub.reload();
  for (const c of conns) await hub.tick(c.id, sig);
  const s = hub.snapshot("homelab")!;
  assert.deepEqual(s.guests.map((g) => g.vmid), [100]);
  const b = s.connections.find((c) => c.id === conns[1]!.id)!.health;
  assert.equal(b.code, "degraded");
  assert.match(b.message ?? "", /duplicate node PVE.*a/);
});

test("diff emits added, removed, and state events after the first snapshot only", async () => {
  const { hub, conns, events, store, env } = setup({
    a: fakeProvider([
      inv([host("pve1")], [guest("pve1", 201), guest("pve1", 203)]),
      inv([host("pve1")], [guest("pve1", 201, { state: "stopped" }), guest("pve1", 202)]),
    ]),
  }, ["a"]);
  await hub.reload();
  await hub.tick(conns[0]!.id, sig);
  assert.equal(events.length, 0);
  await hub.tick(conns[0]!.id, sig);
  assert.deepEqual(events.map((e) => [e.kind, e.target, e.detail]).sort(), [
    ["guest.added", "homelab/pve1/202", "ct202 (lxc)"],
    ["guest.removed", "homelab/pve1/203", "ct203 (lxc)"],
    ["guest.state", "homelab/pve1/201", "running → stopped"],
  ]);
  assert.equal(store.changes({ envId: env.id, limit: 10 }).length, 3);
});

test("host going offline emits host.state", async () => {
  const { hub, conns, events } = setup({ a: fakeProvider([inv([host("pve1")]), inv([host("pve1", { online: false })])]) }, ["a"]);
  await hub.reload();
  await hub.tick(conns[0]!.id, sig); await hub.tick(conns[0]!.id, sig);
  assert.deepEqual(events.map((e) => [e.kind, e.detail]), [["host.state", "online → offline"]]);
});

test("backoff doubles to a 300 s cap and resets on success", async () => {
  const err = new PveError("unreachable", "x", null);
  const { hub, conns } = setup({ a: fakeProvider([err, err, err, err, err, err, err, inv([host("pve1")])]) }, ["a"]);
  await hub.reload();
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) { await hub.tick(conns[0]!.id, sig); delays.push(hub.nextDelayMs(conns[0]!.id)); }
  assert.deepEqual(delays, [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 10_000]);
});

test("connections without credentials report auth-failed and are not polled", async () => {
  const { hub, conns } = setup({ a: fakeProvider([inv([host("pve1")])]) }, ["a", "nocreds"]);
  await hub.reload();
  await hub.tick(conns[1]!.id, sig);
  const h = hub.snapshot("homelab")!.connections.find((c) => c.id === conns[1]!.id)!.health;
  assert.deepEqual([h.code, h.message], ["auth-failed", "no credential saved"]);
});

test("disabled connections report disabled", async () => {
  const { hub, conns, store } = setup({ a: fakeProvider([inv([host("pve1")])]) }, ["a"]);
  store.upsertConnection({ ...conns[0]!, enabled: false });
  await hub.reload();
  assert.equal(hub.snapshot("homelab")!.connections[0]!.health.code, "disabled");
});

test("reload keeps the previous snapshot so diffs continue", async () => {
  const { hub, conns, events } = setup({ a: fakeProvider([inv([host("pve1")], [guest("pve1", 1)]), inv([host("pve1")], [guest("pve1", 1), guest("pve1", 2)])]) }, ["a"]);
  await hub.reload();
  await hub.tick(conns[0]!.id, sig);
  await hub.reload();
  assert.equal(hub.snapshot("homelab")!.guests.length, 1);
  await hub.tick(conns[0]!.id, sig);
  assert.deepEqual(events.map((e) => e.kind), ["guest.added"]);
});

test("cached shares in-flight loads and does not cache failures", async () => {
  const { hub } = setup({}, []);
  let n = 0;
  const load = async () => { n++; await new Promise((r) => setTimeout(r, 5)); return n; };
  const [x, y] = await Promise.all([hub.cached("k", 30_000, load), hub.cached("k", 30_000, load)]);
  assert.deepEqual([x, y, n], [1, 1, 1]);
  let fails = 0;
  const bad = async () => { fails++; throw new Error("boom"); };
  await assert.rejects(hub.cached("f", 30_000, bad));
  await assert.rejects(hub.cached("f", 30_000, bad));
  assert.equal(fails, 2);
});

test("refreshIps records IPv4 addresses of running guests", async () => {
  const { hub, conns } = setup({ a: fakeProvider([inv([host("pve1")], [guest("pve1", 201), guest("pve1", 202, { state: "stopped" })])], {
    "pve1/201": { interfaces: [{ name: "eth0", mac: null, ipv4: ["192.0.2.201"], ipv6: [] }] },
  }) }, ["a"]);
  await hub.reload();
  await hub.tick(conns[0]!.id, sig);
  await hub.refreshIps(conns[0]!.id, sig);
  assert.deepEqual([...hub.guestIps()], [["homelab/pve1/201", ["192.0.2.201"]]]);
});

test("run polls until aborted", async () => {
  const p = fakeProvider([inv([host("pve1")])]);
  const { hub } = setup({ a: p }, ["a"]);
  await hub.reload();
  const ac = new AbortController();
  const done = hub.run(ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  ac.abort();
  await done;
  assert.ok(p.calls >= 1);
});

test("a later connection's first successful poll does not report its guests as added", async () => {
  const { hub, conns, events } = setup({ a: fakeProvider([inv([host("pve1")], [guest("pve1", 1)])]), b: fakeProvider([inv([host("pve2")], [guest("pve2", 2), guest("pve2", 3)])]) });
  await hub.reload();
  await hub.tick(conns[0]!.id, sig);
  await hub.tick(conns[1]!.id, sig);
  await hub.tick(conns[0]!.id, sig);
  assert.deepEqual(events, []);
});

test("a connection recovering from failure does not report its guests as added", async () => {
  const { hub, conns, events } = setup({ a: fakeProvider([inv([host("pve1")], [guest("pve1", 1)])]), b: fakeProvider([new PveError("unreachable", "x", null), inv([host("pve2")], [guest("pve2", 2)])]) });
  await hub.reload();
  await hub.tick(conns[0]!.id, sig);
  await hub.tick(conns[1]!.id, sig);
  await hub.tick(conns[1]!.id, sig);
  assert.deepEqual(events, []);
});

test("removing a connection does not report its guests as removed", async () => {
  const { hub, conns, events, store } = setup({ a: fakeProvider([inv([host("pve1")], [guest("pve1", 1)])]), b: fakeProvider([inv([host("pve2")], [guest("pve2", 2)])]) });
  await hub.reload();
  await hub.tick(conns[0]!.id, sig); await hub.tick(conns[1]!.id, sig);
  store.deleteConnection(conns[1]!.id);
  await hub.reload();
  await hub.tick(conns[0]!.id, sig);
  assert.deepEqual(events, []);
});

test("IP sweeps follow the environment's interval and can be turned off", async () => {
  const { hub, conns, store, env, advance } = setup({ a: fakeProvider([inv([host("pve1")], [guest("pve1", 1)])]) }, ["a"]);
  await hub.reload();
  await hub.tick(conns[0]!.id, sig);
  assert.equal(hub.ipRefreshDue(conns[0]!.id), true, "never swept yet");
  await hub.refreshIps(conns[0]!.id, sig);
  assert.equal(hub.ipRefreshDue(conns[0]!.id), false);
  advance(5 * 60_000);
  assert.equal(hub.ipRefreshDue(conns[0]!.id), true, "default 5 minutes");
  store.upsertEnv({ ...env, ipRefreshMinutes: 0 });
  await hub.reload();
  assert.equal(hub.ipRefreshDue(conns[0]!.id), false, "0 turns sweeps off");
});
