import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture } from "../../../test-util.ts";
import { isCluster, mapResources, ProxmoxProvider } from "./adapter.ts";

const routes: Record<string, string> = {
  "/cluster/resources": "cluster_resources",
  "/cluster/status": "cluster_status",
  "/nodes/pve1/status": "node_status",
  "/nodes/pve1/storage": "storage",
  "/nodes/pve1/lxc/201/status/current": "lxc201_status",
  "/nodes/pve1/lxc/201/config": "lxc201_config",
  "/nodes/pve1/lxc/201/interfaces": "lxc201_interfaces",
  "/nodes/pve1/lxc/201/snapshot": "lxc201_snapshot",
  "/nodes/pve1/lxc/201/rrddata": "lxc201_rrd",
  "/nodes/pve1/rrddata": "node_rrd",
  "/nodes/pve1/tasks": "tasks",
  "/nodes/pve1/qemu/101/config": "qemu101_config",
  "/nodes/pve1/qemu/101/agent/network-get-interfaces": "qemu101_agent_if",
  "/version": "version",
};
const calls: { path: string; query?: Record<string, string | number> }[] = [];
const fake = {
  async get<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    calls.push({ path, query });
    if (path === "/nodes/pve1/qemu/101/status/current") return { ...(loadFixture("lxc201_status") as object), vmid: 101, name: "homeauto", type: "qemu" } as T;
    if (path === "/nodes/pve1/qemu/101/snapshot") return [{ name: "pre-upgrade", description: "before 2025.9", snaptime: 1700000000 }, { name: "current", parent: "pre-upgrade", running: 1 }] as T;
    if (path === "/nodes/pve1/storage/local/content") return [{ volid: "local:backup/vzdump-lxc-201-2026_09_01-03_00_00.tar.zst", size: 123, ctime: 1788000000, notes: "nightly", vmid: 201, content: "backup" }] as T;
    const f = routes[path];
    if (!f) throw new Error(`no route ${path}`);
    return loadFixture(f) as T;
  },
};
const provider = new ProxmoxProvider(fake, "https://192.0.2.10:8006");
const sig = new AbortController().signal;

test("maps cluster resources into hosts, guests, storage", async () => {
  const inv = await provider.inventory(sig);
  assert.equal(inv.hosts.length, 1);
  assert.equal(inv.hosts[0]!.node, "pve1");
  assert.equal(inv.hosts[0]!.online, true);
  assert.equal(inv.hosts[0]!.ip, "192.0.2.10");
  assert.equal(inv.guests.length, 9);
  const proxy = inv.guests.find((g) => g.vmid === 201)!;
  assert.deepEqual([proxy.type, proxy.name, proxy.state, proxy.node], ["lxc", "proxy", "running", "pve1"]);
  assert.ok(inv.storage.some((s) => s.storage === "nfs-isos" && s.shared && s.content.includes("iso")));
});

test("detects standalone vs cluster", () => {
  assert.equal(isCluster(loadFixture("cluster_status") as unknown[]), false);
  assert.equal(isCluster(loadFixture("cluster_status_multi") as unknown[]), true);
});

test("LXC detail includes IPs, hostname, config without noise, no 'current' snapshot", async () => {
  const d = await provider.guestDetail({ kind: "guest", node: "pve1", vmid: 201, type: "lxc" }, sig);
  assert.equal(d.hostname, "proxy");
  assert.equal(d.os, "debian");
  assert.equal(d.agent, "n/a");
  assert.equal(d.guest.state, "running");
  assert.deepEqual(d.interfaces.map((i) => i.name), ["eth0", "wg0"]);
  assert.deepEqual(d.interfaces.find((i) => i.name === "eth0")!.ipv4, ["192.0.2.201"]);
  assert.deepEqual(d.snapshots, []);
  assert.equal(d.config.hostname, "proxy");
  assert.equal("lxc" in d.config, false);
  assert.equal("digest" in d.config, false);
});

test("VM detail reads interfaces from the guest agent and lists snapshots", async () => {
  const d = await provider.guestDetail({ kind: "guest", node: "pve1", vmid: 101, type: "qemu" }, sig);
  assert.equal(d.agent, "ok");
  assert.ok(d.interfaces.some((i) => i.ipv4.includes("192.0.2.34")));
  assert.deepEqual(d.snapshots.map((s) => s.name), ["pre-upgrade"]);
  assert.equal(d.snapshots[0]!.time, 1700000000);
});

test("guest agent failure yields agent unavailable and no interfaces", async () => {
  const p = new ProxmoxProvider({
    async get<T>(path: string, q?: Record<string, string | number>): Promise<T> {
      if (path.endsWith("/agent/network-get-interfaces")) throw new Error("QEMU guest agent is not running");
      return fake.get<T>(path, q);
    },
  }, "https://x:8006");
  const d = await p.guestDetail({ kind: "guest", node: "pve1", vmid: 101, type: "qemu" }, sig);
  assert.equal(d.agent, "unavailable");
  assert.deepEqual(d.interfaces, []);
});

test("host detail parses version, kernel, cpu model, load, storage", async () => {
  const h = await provider.hostDetail("pve1", sig);
  assert.equal(h.pveVersion, "9.1.4");
  assert.match(h.kernel ?? "", /^6\.8/);
  assert.match(h.cpuModel ?? "", /Xeon/);
  assert.deepEqual(h.loadavg, [0.84, 0.93, 1.02]);
  assert.ok(h.storage.some((s) => s.storage === "local" && s.total > 0));
});

test("rrd maps to points and requests the timeframe", async () => {
  calls.length = 0;
  const m = await provider.metrics({ kind: "guest", node: "pve1", vmid: 201, type: "lxc" }, "hour", sig);
  assert.equal(m.points.length, 12);
  assert.equal(m.points[0]!.t, 1790378220_000);
  assert.equal(typeof m.points[0]!.cpu, "number");
  assert.deepEqual(calls[0]!.query, { timeframe: "hour", cf: "AVERAGE" });
});

test("tasks filter by vmid for guests", async () => {
  calls.length = 0;
  const t = await provider.tasks({ kind: "guest", node: "pve1", vmid: 201, type: "lxc" }, 5, sig);
  assert.deepEqual(calls[0]!.query, { limit: 5, vmid: 201 });
  assert.equal(t[0]!.type, "aptupdate");
  assert.equal(t[0]!.end, 1790327299);
});

test("unknown status and odd tags are normalized", () => {
  const inv = mapResources([{ type: "lxc", node: "n", vmid: 5, name: "x", status: "weird", tags: "a;b, c", template: 0, cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1, uptime: 0 }, { type: "sdn" }]);
  assert.equal(inv.guests[0]!.state, "unknown");
  assert.deepEqual(inv.guests[0]!.tags, ["a", "b", "c"]);
  assert.equal(inv.hosts.length + inv.storage.length, 0);
});

test("webUrl deep-links guests and hosts", () => {
  assert.equal(provider.webUrl({ kind: "guest", node: "pve1", vmid: 201, type: "lxc" }), "https://192.0.2.10:8006/#v1:0:=lxc%2F201:4:::::::");
  assert.equal(provider.webUrl({ kind: "host", node: "pve1" }), "https://192.0.2.10:8006/#v1:0:=node%2Fpve1:4:::::::");
  assert.equal(provider.webUrl(null), "https://192.0.2.10:8006/");
});

test("backups come from storages with backup content, skipping failing storages", async () => {
  calls.length = 0;
  const b = await provider.backups({ kind: "guest", node: "pve1", vmid: 201, type: "lxc" }, sig);
  assert.deepEqual(b.map((x) => [x.storage, x.size, x.notes]), [["local", 123, "nightly"]]);
  assert.deepEqual(calls.find((c) => c.path.endsWith("/content"))!.query, { content: "backup", vmid: 201 });
});

test("version reads the release string", async () => {
  assert.equal(await provider.version(sig), "9.1.4");
});
