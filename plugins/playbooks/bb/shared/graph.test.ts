import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaybook } from "../server/parser/parse.ts";
import { loadText } from "../test-util.ts";
import type { RunView } from "./types.ts";
import { toGraph } from "./graph.ts";

const s = parsePlaybook("lab", "site.yml", loadText("playbooks/site.yml"));

test("nodes for hosts, plays, roles, tasks, handlers with deterministic positions", () => {
  const g = toGraph(s, null);
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.equal(byId["hosts:webservers"]!.type, "hosts");
  assert.equal(byId["p0"]!.type, "play"); assert.equal(byId["p0/rcommon"]!.type, "role");
  assert.equal(byId["p0/t1"]!.data.label, "2 Write nginx site config"); assert.equal(byId["p0/h0"]!.type, "handler");
  assert.ok(byId["p1"]!.position.y > byId["p0/t3"]!.position.y, "plays stack vertically");
  assert.deepEqual(toGraph(s, null), g, "deterministic");
});
test("edges: hosts→play, play→first task, task→next, task→handler (notify)", () => {
  const g = toGraph(s, null);
  const has = (source: string, target: string, kind: string) => g.edges.some((e) => e.source === source && e.target === target && e.kind === kind);
  assert.ok(has("hosts:webservers", "p0", "hosts") && has("p0", "p0/t0", "seq") && has("p0/t0", "p0/t1", "seq") && has("p0/t1", "p0/h0", "notify") && has("p0", "p0/rcommon", "contains"));
});
test("run view colours task nodes and adds host dots", () => {
  const view: RunView = { runId: "run_x", status: "failed", playbook: "site.yml", env: { slug: "lab", name: "Lab", kind: "lab", color: "#0f0" }, hosts: ["web-01", "web-02"], counters: { ok: 1, changed: 0, failed: 1, unreachable: 0, skipped: 0 }, recap: null, investigations: [], startedAt: 1, endedAt: 2, lastLine: null,
    plays: [{ id: "p0", name: "Web servers", tasks: [{ nodeId: "p0/t1", name: "Write nginx site config", cells: { "web-01": "changed", "web-02": "failed" } }] }] };
  const g = toGraph(s, view);
  const n = g.nodes.find((x) => x.id === "p0/t1")!;
  assert.equal(n.data.state, "failed"); assert.deepEqual(n.data.hostDots, [{ host: "web-01", state: "changed" }, { host: "web-02", state: "failed" }]);
  assert.equal(g.nodes.find((x) => x.id === "p0/t0")!.data.state, "pending");
});
test("no two nodes share a position", () => {
  const pos = toGraph(s, null).nodes.map((n) => `${n.position.x},${n.position.y}`);
  assert.equal(new Set(pos).size, pos.length);
});
test("roles do not overlap tasks or the handler column", () => {
  const g = toGraph(s, null);
  const role = g.nodes.find((n) => n.id === "p0/rcommon")!;
  const first = g.nodes.find((n) => n.id === "p0/t0")!;
  assert.ok(first.position.y > role.position.y);
  assert.ok(g.nodes.filter((n) => n.type === "role").every((n) => n.position.x < 220 * 3));
});
test("node data carries no undefined values (the RPC layer rejects non-JSON results)", () => {
  for (const view of [null, { runId: "run_x", status: "running", playbook: "site.yml", env: { slug: "lab", name: "Lab", kind: "lab", color: "#0f0" }, hosts: ["web-01"], counters: { ok: 0, changed: 0, failed: 0, unreachable: 0, skipped: 0 }, recap: null, investigations: [], startedAt: 1, endedAt: null, lastLine: null, plays: [] } satisfies RunView | null]) {
    for (const n of toGraph(s, view).nodes) {
      for (const [k, v] of Object.entries(n.data)) assert.notEqual(v, undefined, `${n.id}.data.${k}`);
    }
  }
});
