import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphEdge, GraphNode } from "../shared/graph.ts";
import { stateBorderClass, toFlowEdges, toFlowNodes } from "./graph-model.ts";

const nodes: GraphNode[] = [
  { id: "hosts:webservers", type: "hosts", position: { x: 0, y: 0 }, data: { label: "webservers" } },
  { id: "p0", type: "play", position: { x: 220, y: 0 }, data: { label: "Web servers" } },
  { id: "p0/t0", type: "task", position: { x: 220, y: 72 }, data: { label: "1 Install nginx", state: "ok", nodeId: "p0/t0", hostDots: [{ host: "web-01", state: "ok" }] } },
  { id: "p0/t1", type: "task", position: { x: 220, y: 144 }, data: { label: "2 Write config", state: "pending", nodeId: "p0/t1" } },
  { id: "p0/h0", type: "handler", position: { x: 660, y: 144 }, data: { label: "restart nginx" } },
];
const edges: GraphEdge[] = [
  { id: "hosts:webservers->p0", source: "hosts:webservers", target: "p0", kind: "hosts" },
  { id: "p0->p0/t0", source: "p0", target: "p0/t0", kind: "seq" },
  { id: "p0/t0->p0/t1", source: "p0/t0", target: "p0/t1", kind: "contains" },
  { id: "p0/t1~p0/h0", source: "p0/t1", target: "p0/h0", kind: "notify" },
];

test("nodes keep ids, types and positions; hosts nodes are not selectable", () => {
  const out = toFlowNodes(nodes, null);
  assert.deepEqual(out.map((n) => n.id), nodes.map((n) => n.id));
  assert.equal(out[0]!.type, "hosts"); assert.equal(out[0]!.selectable, false);
  assert.equal(out[2]!.type, "task"); assert.equal(out[2]!.selectable, true);
  assert.deepEqual(out[2]!.position, { x: 220, y: 72 });
  assert.equal(out[2]!.data.label, "1 Install nginx"); assert.equal(out[2]!.data.state, "ok");
  assert.equal(out[2]!.selected, false);
});

test("the selected node id is marked selected", () => {
  const out = toFlowNodes(nodes, "p0/t1");
  assert.equal(out.find((n) => n.id === "p0/t1")!.selected, true);
  assert.equal(out.find((n) => n.id === "p0/t0")!.selected, false);
});

test("play nodes get n/m task progress only when a run view is present", () => {
  assert.equal(toFlowNodes(nodes, null).find((n) => n.id === "p0")!.data.progress, "1/2 tasks");
  const plain = nodes.map((n) => ({ ...n, data: { ...n.data, state: undefined } }));
  assert.equal(toFlowNodes(plain, null).find((n) => n.id === "p0")!.data.progress, undefined);
});

test("edges: notify dashed and not animated, hosts thick, contains thin muted, seq default", () => {
  const out = toFlowEdges(edges);
  assert.deepEqual(out.map((e) => e.id), edges.map((e) => e.id));
  const by = Object.fromEntries(out.map((e) => [e.id, e]));
  assert.equal(by["p0/t1~p0/h0"]!.style?.strokeDasharray, "4 2"); assert.equal(by["p0/t1~p0/h0"]!.animated, false); assert.equal(by["p0/t1~p0/h0"]!.sourceHandle, "notify");
  assert.match(by["hosts:webservers->p0"]!.className ?? "", /hosts/); assert.equal(by["hosts:webservers->p0"]!.style?.strokeWidth, 3);
  assert.match(by["p0/t0->p0/t1"]!.className ?? "", /contains/); assert.equal(by["p0/t0->p0/t1"]!.style?.strokeWidth, 1);
  assert.match(by["p0->p0/t0"]!.className ?? "", /seq/); assert.equal(by["p0->p0/t0"]!.style, undefined);
  assert.equal(by["p0->p0/t0"]!.source, "p0"); assert.equal(by["p0->p0/t0"]!.target, "p0/t0");
});

test("state → left border class covers every cell state", () => {
  assert.equal(stateBorderClass("ok"), "border-l-emerald-500"); assert.equal(stateBorderClass("changed"), "border-l-emerald-500");
  assert.equal(stateBorderClass("failed"), "border-l-destructive"); assert.equal(stateBorderClass("unreachable"), "border-l-destructive");
  assert.match(stateBorderClass("running"), /border-l-primary/); assert.match(stateBorderClass("running"), /animate-pulse/);
  assert.equal(stateBorderClass("pending"), "border-l-border"); assert.equal(stateBorderClass("skipped"), "border-l-muted");
  assert.equal(stateBorderClass(undefined), "border-l-border", "no run view → pending look");
});
