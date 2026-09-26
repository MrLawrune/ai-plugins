import { test } from "node:test";
import assert from "node:assert/strict";
import { envRow, guest, host, snapshotOf } from "../test-util.ts";
import { applyBudget, envCard, envIndexLine, guestCard, hostCard, registryMarkdown } from "./context.ts";
import type { ActivityRow } from "./store.ts";

const GiB = 1024 ** 3;
const snap = snapshotOf(
  envRow("homelab", "lab", { rules: "Use Podman, not Docker.\nPrefer LXCs." }),
  [host("pve1", { ip: "192.0.2.10", cpu: 0.03, maxcpu: 24, mem: 57 * GiB, maxmem: 100 * GiB, disk: 28 * GiB, maxdisk: 100 * GiB, uptime: 12 * 86400 })],
  [
    guest("pve1", 201, { name: "proxy", maxcpu: 2, mem: 90 * 1024 ** 2, maxmem: GiB, disk: 5.6 * GiB, maxdisk: 16 * GiB, uptime: 12 * 86400, tags: ["edge"] }),
    guest("pve1", 103, { name: "romm", state: "stopped", uptime: 0 }),
    guest("pve1", 900, { name: "tmpl", state: "stopped", template: true }),
  ],
);
const ips = new Map([["homelab/pve1/201", ["192.0.2.201"]]]);
const now = 1_000_000;
const act: ActivityRow[] = [{ id: 1, envId: "e", target: "homelab/pve1/201", threadId: "thr_abc", turnId: "t", itemId: "i", command: "ssh pve1 'pct exec 201 -- podman ps'", phase: "completed", exitCode: 0, at: now - 5 * 60_000 }];

test("env index line counts hosts, running guests (templates excluded), and health", () => {
  assert.equal(envIndexLine(snap), "homelab (lab) · 1/1 hosts · 1/2 running · ok");
});

test("guest card", () => {
  assert.equal(guestCard(snap, "pve1", 201, null, act, { budget: 40, ips, now }), [
    "homelab/pve1/201 proxy · lxc · running · up 12d",
    "cpu 2 cores · mem 90 MiB/1 GiB · disk 5.6 GiB/16 GiB",
    "ips 192.0.2.201",
    "tags edge",
    "recent agent activity:",
    "  5m ago thr_abc $ ssh pve1 'pct exec 201 -- podman ps'",
  ].join("\n"));
  assert.equal(guestCard(snap, "pve1", 999, null, [], { budget: 40, ips, now }), null);
});

test("guest card with detail adds os, hostname, snapshots, and notes", () => {
  const card = guestCard(snap, "pve1", 201, {
    guest: snap.guests[0]!, hostname: "proxy", os: "debian", interfaces: [{ name: "eth0", mac: null, ipv4: ["192.0.2.201"], ipv6: [] }],
    config: {}, notes: "Reverse proxy\n\nCaddyfile at /etc/proxy\nline3\nline4", snapshots: [{ name: "pre", description: "", time: 1, parent: null }], agent: "n/a",
  }, [], { budget: 40, ips: new Map(), now });
  assert.match(card!, /^os debian · hostname proxy$/m);
  assert.match(card!, /^snapshots pre$/m);
  assert.match(card!, /^notes: Reverse proxy \| Caddyfile at \/etc\/proxy \| line3$/m);
});

test("host card", () => {
  assert.equal(hostCard(snap, "pve1", [], { budget: 40, now }), [
    "homelab/pve1 · online · up 12d · 192.0.2.10",
    "cpu 3% of 24 · mem 57% of 100 GiB · disk 28% of 100 GiB",
    "guests 1 running / 2",
  ].join("\n"));
});

test("env card lists hosts, guests, and rules on request", () => {
  const card = envCard(snap, { rules: true, budget: 60, ips });
  assert.match(card, /^homelab \(lab\)/);
  assert.match(card, /^ {2}pve1 192\.0\.2\.10 cpu 3% mem 57% disk 28% up 12d$/m);
  assert.match(card, /^ {2}201 proxy lxc running 192\.0\.2\.201$/m);
  assert.match(card, /^ {2}103 romm lxc stopped -$/m);
  assert.doesNotMatch(card, /tmpl/);
  assert.match(card, /^Rules:\nUse Podman, not Docker\.\nPrefer LXCs\.$/m);
  assert.doesNotMatch(envCard(snap, { rules: false, budget: 60, ips }), /Rules:/);
});

test("applyBudget keeps at most budget lines and points to the registry", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);
  const out = applyBudget(lines, 10, "homelab").split("\n");
  assert.equal(out.length, 10);
  assert.equal(out[9], "… 91 more lines (bb infra registry homelab)");
  assert.equal(applyBudget(["a", "b"], 10, "x"), "a\nb");
});

test("registry markdown has host and guest tables", () => {
  const md = registryMarkdown(snap, ips);
  assert.match(md, /^# Homelab \(lab\)$/m);
  assert.match(md, /^\| 201 \| proxy \| lxc \| pve1 \| running \| 192\.0\.2\.201 \| edge \|$/m);
  assert.match(md, /^\| pve1 \| 192\.0\.2\.10 \| online \|/m);
});
