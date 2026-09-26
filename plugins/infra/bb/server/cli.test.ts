import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeProvider, guest, host, inv, serviceHarness } from "../test-util.ts";
import { createCli } from "./cli.ts";

const provider = () => fakeProvider([inv([host("pve1", { ip: "192.0.2.10" })], Array.from({ length: 120 }, (_, i) => guest("pve1", 100 + i, { name: `ct${100 + i}` })))]);

async function setup() {
  const h = await serviceHarness([{ slug: "homelab", rules: "Use Podman.", conns: { pve1: provider() } }]);
  const meta: { threadId: string; value: unknown }[] = [];
  const cli = createCli({
    service: h.service,
    pins: h.pins,
    threadExists: async (id) => id.startsWith("thr_"),
    setThreadMetadata: async (threadId, value) => { meta.push({ threadId, value }); },
  });
  const run = (...argv: string[]) => cli.run(argv, {});
  return { h, run, meta };
}

test("envs lists one line per environment, with --json", async () => {
  const { run } = await setup();
  const r = await run("envs");
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout!.trim(), "homelab (lab) · 1/1 hosts · 120/120 running · ok");
  const j = JSON.parse((await run("envs", "--json")).stdout!);
  assert.equal(j.envs[0].env.slug, "homelab");
});

test("context respects the default 60-line budget and --budget", async () => {
  const { run } = await setup();
  const r = await run("context", "homelab");
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout!.trimEnd().split("\n").length, 60);
  assert.match(r.stdout!, /more lines \(bb infra registry homelab\)/);
  assert.equal((await run("context", "homelab", "--budget", "10")).stdout!.trimEnd().split("\n").length, 10);
  assert.match((await run("context", "homelab/pve1/150", "--rules")).stdout!, /^homelab\/pve1\/150 ct150[\s\S]*Rules \(homelab\):\nUse Podman\./);
});

test("unknown targets fail with not_found in the json envelope", async () => {
  const { run } = await setup();
  const r = await run("context", "homelab/PV09", "--json");
  assert.notEqual(r.exitCode, 0);
  assert.equal(JSON.parse(r.stdout!).error.code, "not_found");
  assert.notEqual((await run("context", "not a target")).exitCode, 0);
});

test("registry and rules print markdown and text", async () => {
  const { run } = await setup();
  assert.match((await run("registry", "homelab")).stdout!, /^# Homelab \(lab\)/);
  assert.equal((await run("rules", "homelab")).stdout!.trim(), "Use Podman.");
});

test("attach pins scope, writes thread metadata, and detach clears it", async () => {
  const { h, run, meta } = await setup();
  const r = await run("attach", "thr_x", "homelab/pve1/101", "homelab", "--rules");
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(h.pins.get("thr_x")?.targets, ["homelab/pve1/101", "homelab"]);
  assert.deepEqual(meta.at(-1), { threadId: "thr_x", value: { targets: ["homelab/pve1/101", "homelab"], rules: true } });
  assert.notEqual((await run("attach", "nothread", "homelab")).exitCode, 0);
  assert.notEqual((await run("attach", "thr_x", "homelab/pve1/999")).exitCode, 0);
  assert.equal((await run("detach", "thr_x")).exitCode, 0);
  assert.equal(h.pins.get("thr_x"), null);
  assert.deepEqual(meta.at(-1), { threadId: "thr_x", value: null });
});

test("activity lists recent commands for a target", async () => {
  const { h, run } = await setup();
  h.pageBox.pages.push([{ seq: 1, type: "item/completed", createdAt: h.now() - 1000, threadId: "thr_a", scope: { kind: "turn", turnId: "t" }, data: { item: { type: "commandExecution", id: "i1", command: "ssh pve1 'pct exec 150 -- ls'", exitCode: 0 } } }]);
  await h.activity.onThreadEvents("thr_a");
  const r = await run("activity", "homelab/pve1/150");
  assert.match(r.stdout!, /thr_a .*ssh pve1 'pct exec 150 -- ls'/);
});
