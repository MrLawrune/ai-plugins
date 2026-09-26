import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeProvider, guest, host, inv, serviceHarness } from "../test-util.ts";
import type { RawEvent } from "./activity.ts";
import { webBaseFor } from "./store.ts";

const homelab = () => fakeProvider([inv([host("pve1", { ip: "192.0.2.10" })], [guest("pve1", 201, { name: "proxy" }), guest("pve1", 103, { name: "romm", state: "stopped" })])], {
  "pve1/201": { interfaces: [{ name: "eth0", mac: null, ipv4: ["192.0.2.201"], ipv6: [] }], os: "debian", hostname: "proxy" },
});
const staging = () => fakeProvider([inv([host("stage1", { ip: "198.51.100.5" })], [guest("stage1", 201, { name: "web" })])]);

function cmd(seq: number, type: "item/started" | "item/completed", command: string, at: number, threadId = "thr_a"): RawEvent {
  return { seq, type, createdAt: at, threadId, scope: { kind: "turn", turnId: "t1" }, data: { item: { type: "commandExecution", id: `i${seq}`, command, exitCode: 0 } } };
}

test("resolve normalizes node case and rejects unknown or malformed targets", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: homelab() } }]);
  assert.equal(h.service.resolve("homelab/pve1/201")?.target, "homelab/pve1/201");
  for (const t of ["homelab/PV09", "homelab/pve1/999", "nope", "../x", "homelab/pve1/201/x"]) assert.equal(h.service.resolve(t), null, t);
});

test("the same VMID in two environments resolves independently", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: homelab() } }, { slug: "staging", kind: "staging", conns: { s1: staging() } }]);
  const a = h.service.resolve("homelab/pve1/201");
  const b = h.service.resolve("staging/stage1/201");
  assert.equal(a?.kind === "guest" && a.guest.name, "proxy");
  assert.equal(b?.kind === "guest" && b.guest.name, "web");
});

test("overview summarizes each environment", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: homelab() } }]);
  const [e] = h.service.overview().envs;
  assert.deepEqual([e!.env.slug, e!.hosts, e!.guests, e!.health, e!.activeThreads], ["homelab", { up: 1, total: 1 }, { running: 1, total: 2 }, "ok", []]);
});

test("guest view returns detail, records IPs, and not-found for removed guests", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: homelab() } }]);
  const g = await h.service.guestView("homelab/pve1/201");
  assert.equal(g?.detail.hostname, "proxy");
  assert.deepEqual(h.hub.guestIps().get("homelab/pve1/201"), ["192.0.2.201"]);
  assert.equal(await h.service.guestView("homelab/pve1/555"), null);
  assert.equal(h.service.guestSummary("homelab/pve1/201")?.ips[0], "192.0.2.201");
});

test("CLI-style guest card fits the default budget and includes live detail", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: homelab() } }]);
  const card = await h.service.card("homelab/pve1/201", { budget: 60, rules: false });
  assert.ok(card!.split("\n").length <= 60);
  assert.match(card!, /^homelab\/pve1\/201 proxy/);
  assert.match(card!, /os debian · hostname proxy/);
});

test("rules are appended to target cards only when asked", async () => {
  const h = await serviceHarness([{ slug: "homelab", rules: "Use Podman, not Docker.", conns: { pve1: homelab() } }]);
  assert.match(h.service.cardSync("homelab/pve1", { budget: 60, rules: true })!, /Rules \(homelab\):\nUse Podman, not Docker\./);
  assert.doesNotMatch(h.service.cardSync("homelab/pve1", { budget: 60, rules: false })!, /Rules/);
});

test("ask prompt includes the card and rules, and demands confirmation for prod", async () => {
  const h = await serviceHarness([{ slug: "acme", kind: "prod", rules: "Change window Sundays.", conns: { pve1: homelab() } }]);
  const p = (await h.service.askPrompt("acme/pve1/201", "troubleshoot"))!;
  assert.match(p, /^Troubleshoot problems with acme\/pve1\/201 in the Acme \(prod\) environment\./);
  assert.match(p, /Change window Sundays\./);
  assert.match(p, /confirm with me before making changes/);
  assert.equal(await h.service.askPrompt("acme/pve1/999", "ask"), null);
});

test("thread targets and running state come from recorded agent commands", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: homelab() } }]);
  h.pageBox.pages.push([cmd(1, "item/started", "ssh pve1 'pct exec 201 -- ls'", h.now())]);
  await h.activity.onThreadEvents("thr_a");
  const targets = h.service.threadTargets("thr_a");
  assert.deepEqual(targets.map((t) => [t.target, t.kind, t.running]).sort(), [["homelab/pve1", "host", true], ["homelab/pve1/201", "guest", true]]);
  assert.deepEqual(h.service.runningThreads(), [{ threadId: "thr_a", targets: ["homelab/pve1", "homelab/pve1/201"] }]);
  assert.deepEqual(h.service.overview().envs[0]!.activeThreads, ["thr_a"]);
  assert.equal(h.service.envView("homelab")!.guests.find((g) => g.vmid === 201)!.active, true);
});

test("settings never expose secrets; saving a secret reports hasSecret", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: homelab() } }]);
  const env = h.store.getEnvBySlug("homelab")!;
  const saved = await h.service.saveConnection({ envId: env.id, label: "pve2", baseUrl: "https://192.0.2.2:8006", authKind: "token", username: "bb-view@pve!infra", tlsMode: "insecure", tlsFingerprint: "", enabled: true, secret: "super-secret-value" });
  assert.equal(saved.hasSecret, true);
  const all = JSON.stringify(await h.service.settings());
  assert.doesNotMatch(all, /super-secret-value/);
  assert.equal(h.reloads(), 1);
  await h.service.saveConnection({ id: saved.id, envId: env.id, label: "pve2", baseUrl: "https://192.0.2.2:8006", authKind: "token", username: "bb-view@pve!infra", tlsMode: "insecure", tlsFingerprint: "", enabled: true });
  assert.equal(await h.secrets.get(saved.id), "super-secret-value", "omitted secret keeps the stored one");
  await h.service.deleteConnection(saved.id);
  assert.equal(await h.secrets.get(saved.id), null);
});

test("pinned TLS requires a fingerprint; CA mode requires a PEM", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: {} }]);
  const env = h.store.getEnvBySlug("homelab")!;
  const base = { envId: env.id, label: "x", baseUrl: "https://192.0.2.9:8006", authKind: "token" as const, username: "a@pve!b", tlsFingerprint: "", enabled: true };
  await assert.rejects(h.service.saveConnection({ ...base, tlsMode: "pinned" }), /fingerprint/);
  await assert.rejects(h.service.saveConnection({ ...base, tlsMode: "ca" }), /CA certificate/);
});

test("probe reports errors as data", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: {} }]);
  assert.deepEqual(await h.service.probe("https://bad:8006"), { ok: false, error: "ECONNREFUSED" });
  assert.equal((await h.service.probe("https://ok:8006")).ok, true);
});

test("deleting an environment removes its connection secrets", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: homelab() } }]);
  const c = h.store.listConnections()[0]!;
  await h.secrets.set(c.id, "tok");
  await h.service.deleteEnv(c.envId);
  assert.equal(await h.secrets.get(c.id), null);
  assert.deepEqual(h.service.overview().envs, []);
});

test("pinned instructions render cards for pinned targets and rules when requested", async () => {
  const h = await serviceHarness([{ slug: "homelab", rules: "Prefer LXCs.", conns: { pve1: homelab() } }]);
  h.pins.set("thr_p", ["homelab/pve1/201"], true);
  const text = h.pins.instructions("thr_p", (p) => h.service.renderPin(p))!;
  assert.match(text, /homelab\/pve1\/201 proxy/);
  assert.match(text, /Rules \(homelab\):\nPrefer LXCs\./);
  assert.equal(h.pins.instructions("thr_other", (p) => h.service.renderPin(p)), null);
});

test("activity text shows one row per command run, preferring the completed phase", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: homelab() } }]);
  const c = "ssh pve1 'pct exec 201 -- uptime'";
  const same = (e: RawEvent): RawEvent => ({ ...e, data: { item: { ...e.data!.item!, id: "first" } } });
  h.pageBox.pages.push([same(cmd(10, "item/started", c, h.now() - 3000)), same(cmd(11, "item/completed", c, h.now() - 2000))]);
  h.pageBox.pages.push([{ ...cmd(12, "item/started", c, h.now() - 1000), data: { item: { type: "commandExecution", id: "second", command: c } } }]);
  await h.activity.onThreadEvents("thr_a");
  await h.activity.onThreadEvents("thr_a");
  const rows = h.service.activityText("homelab/pve1/201", 60_000, 20);
  assert.deepEqual(rows.map((r) => r.phase), ["started", "completed"]);
  assert.equal(new Set(rows.map((r) => r.itemId)).size, 2);
});

test("Open in Proxmox uses the connection's web UI link when set", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: homelab() } }]);
  const c = h.store.listConnections()[0]!;
  assert.equal(webBaseFor(c), c.baseUrl);
  assert.equal(webBaseFor({ ...c, webUrl: "https://pve1.example.dev/" }), "https://pve1.example.dev/");
});

test("environment rules include the linked conventions file", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "conv-"));
  const file = join(dir, "AGENTS.md");
  await writeFile(file, "Always use Podman quadlets.\n");
  const h = await serviceHarness([{ slug: "homelab", rules: "Prefer LXCs.", conns: { pve1: homelab() } }]);
  const env = h.store.getEnvBySlug("homelab")!;
  await h.service.saveEnv({ ...env, conventionsPath: file });
  const rules = await h.service.rulesText("homelab");
  assert.match(rules!, /Prefer LXCs\.[\s\S]*Conventions \(.*AGENTS\.md\):\nAlways use Podman quadlets\./);
  assert.match((await h.service.card("homelab/pve1", { budget: 60, rules: true }))!, /Always use Podman quadlets\./);
  assert.match(h.service.renderPin({ threadId: "t", targets: ["homelab/pve1"], rulesIncluded: true, pinnedAt: 0 }), /Always use Podman quadlets\./);
});
