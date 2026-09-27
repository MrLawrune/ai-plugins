import type { CellState, PlaybookSummary, RunView, TaskSummary } from "./types.ts";

export const COL = 220;
export const ROW = 72;

export interface GraphNode {
  id: string;
  type: "hosts" | "play" | "role" | "task" | "block" | "handler" | "include";
  position: { x: number; y: number };
  data: { label: string; sub?: string; state?: CellState; hostDots?: { host: string; state: CellState }[]; nodeId?: string };
}
export interface GraphEdge { id: string; source: string; target: string; kind: "seq" | "contains" | "notify" | "hosts" }

const RANK: CellState[] = ["unreachable", "failed", "running", "changed", "ok", "skipped", "pending"];
const aggregate = (cells: Record<string, CellState>): CellState => {
  const v = Object.values(cells);
  return v.length ? RANK.find((r) => v.includes(r))! : "pending";
};

export function toGraph(s: PlaybookSummary, view: RunView | null): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const cellsByNode = new Map<string, Record<string, CellState>>();
  for (const p of view?.plays ?? []) for (const t of p.tasks) if (t.nodeId) cellsByNode.set(t.nodeId, t.cells);
  let y = 0;
  let step = 0;
  const flatten = (ts: TaskSummary[]): TaskSummary[] =>
    ts.flatMap((t) => (t.children ? [t, ...flatten([...t.children.block, ...t.children.rescue, ...t.children.always])] : [t]));
  for (const play of s.plays) {
    const hostsId = `hosts:${play.hosts}`;
    if (!nodes.some((n) => n.id === hostsId)) {
      nodes.push({ id: hostsId, type: "hosts", position: { x: 0, y }, data: { label: play.hosts, sub: view ? `${view.hosts.length} hosts` : undefined } });
    }
    nodes.push({
      id: play.id, type: "play", position: { x: COL, y },
      data: { label: play.name, sub: [play.become ? "become" : null, play.serial ? `serial ${play.serial}` : null].filter(Boolean).join(" · ") || undefined },
    });
    edges.push({ id: `${hostsId}->${play.id}`, source: hostsId, target: play.id, kind: "hosts" });
    let x = COL;
    let prev = play.id;
    y += ROW;
    for (const r of play.roles) {
      if (x >= COL * 3) { x = COL; y += ROW; } // keep the handler column (x = COL * 3) free
      nodes.push({ id: r.id, type: "role", position: { x, y }, data: { label: `role ${r.name}`, sub: r.when ?? undefined } });
      edges.push({ id: `${play.id}->${r.id}`, source: play.id, target: r.id, kind: "contains" });
      x += COL;
    }
    if (play.roles.length > 0) y += ROW;
    const tasks = flatten([...play.preTasks, ...play.tasks, ...play.postTasks]);
    for (const t of tasks) {
      const cells = cellsByNode.get(t.id);
      const state: CellState | undefined = view ? (cells ? aggregate(cells) : "pending") : undefined;
      const label = t.action === "block" ? t.plain : `${++step} ${t.plain.replace(/ → .*$/, "")}`;
      nodes.push({
        id: t.id, type: t.include ? "include" : t.action === "block" ? "block" : "task", position: { x: COL, y },
        data: {
          label, sub: t.when ? `when: ${t.when}` : undefined, state, nodeId: t.id,
          hostDots: cells ? Object.entries(cells).map(([host, st]) => ({ host, state: st })) : undefined,
        },
      });
      edges.push({ id: `${prev}->${t.id}`, source: prev, target: t.id, kind: prev !== play.id && t.id.split("/").length > prev.split("/").length ? "contains" : "seq" });
      for (const n of new Set(t.notify)) {
        const h = play.handlers.find((hh) => hh.name === n || (hh as { listen?: string }).listen === n);
        if (h) edges.push({ id: `${t.id}~${h.id}`, source: t.id, target: h.id, kind: "notify" });
      }
      prev = t.id;
      y += ROW;
    }
    // handlers sit in the far column, aligned with the last task rows
    play.handlers.forEach((h, i) =>
      nodes.push({ id: h.id, type: "handler", position: { x: COL * 3, y: y - ROW * (play.handlers.length - i) }, data: { label: h.name ?? h.plain } }),
    );
    y += ROW;
  }
  // RPC results must be strict JSON: drop keys whose value is undefined.
  for (const n of nodes) n.data = Object.fromEntries(Object.entries(n.data).filter(([, v]) => v !== undefined)) as GraphNode["data"];
  return { nodes, edges };
}
