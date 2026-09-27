// Pure view model: GraphNode/GraphEdge from the RPC → React Flow Node/Edge objects. No React, no DOM.
import type { Edge, Node } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "../shared/graph.ts";
import type { CellState } from "../shared/types.ts";

export type FlowNodeData = GraphNode["data"] & { kind: GraphNode["type"]; progress?: string };
export type FlowNode = Node<FlowNodeData, GraphNode["type"]>;
export type FlowEdge = Edge;

/** Play `p<i>` owns task nodes `p<i>/t…` (roles and handlers are not steps). */
const isTaskOf = (playId: string, n: GraphNode) => (n.type === "task" || n.type === "include") && n.id.startsWith(`${playId}/t`);

const STATE_BORDER: Record<CellState, string> = {
  ok: "border-l-emerald-500", changed: "border-l-emerald-500",
  failed: "border-l-destructive", unreachable: "border-l-destructive",
  running: "border-l-primary animate-pulse",
  pending: "border-l-border", skipped: "border-l-muted",
};

/** Tailwind classes for a step node's state-coloured left border; no run view reads as pending. */
export const stateBorderClass = (state: CellState | undefined): string => STATE_BORDER[state ?? "pending"];

export function toFlowNodes(nodes: GraphNode[], selected: string | null): FlowNode[] {
  return nodes.map((n) => {
    const data: FlowNodeData = { ...n.data, kind: n.type };
    if (n.type === "play") {
      const tasks = nodes.filter((t) => isTaskOf(n.id, t));
      const live = tasks.filter((t) => t.data.state !== undefined);
      if (live.length) data.progress = `${live.filter((t) => t.data.state !== "pending").length}/${tasks.length} tasks`;
    }
    return { id: n.id, type: n.type, position: n.position, data, selectable: n.type !== "hosts", draggable: false, selected: n.id === selected };
  });
}

const EDGE_STYLE: Record<GraphEdge["kind"], Pick<Edge, "className" | "style" | "animated" | "sourceHandle">> = {
  seq: { className: "pb-edge-seq" },
  contains: { className: "pb-edge-contains", style: { strokeWidth: 1, opacity: 0.6 } },
  notify: { className: "pb-edge-notify", style: { strokeDasharray: "4 2" }, animated: false, sourceHandle: "notify" },
  hosts: { className: "pb-edge-hosts", style: { strokeWidth: 3 } },
};

export function toFlowEdges(edges: GraphEdge[]): FlowEdge[] {
  return edges.map((e) => ({ id: e.id, source: e.source, target: e.target, ...EDGE_STYLE[e.kind] }));
}
