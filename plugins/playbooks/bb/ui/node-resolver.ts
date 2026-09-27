// Pure: resolve a graph/list node id (`p<i>`, `p<i>/t<j>[/t<k>…]`, `p<i>/h<j>`, `p<i>/r<name>`) against a playbook summary.
import type { PlaybookSummary, PlaySummary, TaskSummary } from "../shared/types.ts";

export type ResolvedNode =
  | { kind: "play"; play: PlaySummary }
  | { kind: "role"; play: PlaySummary; name: string }
  | { kind: "task"; play: PlaySummary; t: TaskSummary }
  | { kind: "handler"; play: PlaySummary; t: TaskSummary };

const ROLE_ID = /^p\d+\/r(.+)$/;

const walk = (ts: TaskSummary[], id: string): TaskSummary | null => {
  for (const t of ts) {
    if (t.id === id) return t;
    const c = t.children;
    const hit = c ? walk([...c.block, ...c.rescue, ...c.always], id) : null;
    if (hit) return hit;
  }
  return null;
};

export function resolveNode(summary: PlaybookSummary, id: string): ResolvedNode | null {
  const play = summary.plays.find((p) => p.id === id || id.startsWith(`${p.id}/`));
  if (!play) return null;
  if (play.id === id) return { kind: "play", play };
  const task = walk([...play.preTasks, ...play.tasks, ...play.postTasks], id);
  if (task) return { kind: "task", play, t: task };
  const handler = play.handlers.find((h) => h.id === id);
  if (handler) return { kind: "handler", play, t: handler };
  const role = ROLE_ID.exec(id);
  if (role && play.roles.some((r) => r.id === id)) return { kind: "role", play, name: role[1]! };
  return null;
}
