// Pure derivation of the play → task → host matrix from run events (spec §5.3), plus event → parser node matching.
import type { CellState, EnvBadgeDto, HostStats, PlaybookSummary, RunView, TaskSummary } from "../shared/types.ts";
import type { InvestigationRow, RunEventRow, RunRow } from "./store.ts";
import { cleanName } from "../shared/format.ts";
import { recapFromStats } from "./events/normalize.ts";

/** Gathering Facts is not in the summary, so it never consumes a task ordinal. */
export const FACTS = "gathering facts";

const flatten = (tasks: TaskSummary[]): TaskSummary[] =>
  tasks.flatMap((t) => (t.children ? [...flatten(t.children.block), ...flatten(t.children.rescue), ...flatten(t.children.always)] : [t]));

export function matchNodeId(summary: PlaybookSummary | null, playName: string, taskName: string, taskIndexInPlay: number): string | null {
  const play = summary?.plays.find((p) => p.name === playName);
  if (!play) return null;
  const name = cleanName(taskName);
  if (name.toLowerCase() === FACTS) return null;
  const flat = flatten([...play.preTasks, ...play.tasks, ...play.postTasks]);
  const same = (t: TaskSummary): boolean => (t.name ?? t.plain).trim() === name;
  const at = flat[taskIndexInPlay];
  if (at && same(at)) return at.id;
  const candidates = flat.filter(same);
  if (candidates.length === 0) return null;
  return (candidates[taskIndexInPlay] ?? candidates[candidates.length - 1]!).id;
}

/** A failure the play carried on past (`ignore_errors`): the normaliser leaves `failed` false, and Ansible's recap counts it as ok + ignored. */
export const isIgnoredFailure = (ev: Pick<RunEventRow, "kind" | "failed">): boolean => ev.kind === "host_failed" && !ev.failed;

const RESULT: Partial<Record<RunEventRow["kind"], CellState>> = { host_failed: "failed", host_unreachable: "unreachable", host_skipped: "skipped" };

export function buildRunView(run: RunRow, env: EnvBadgeDto, events: RunEventRow[], summary: PlaybookSummary | null, investigations: InvestigationRow[]): RunView {
  const plays: RunView["plays"] = [];
  const hosts: string[] = [];
  let taskIndex = 0;
  let lastStats: RunEventRow | null = null;
  const seen = (h: string): void => { if (!hosts.includes(h)) hosts.push(h); };
  const curTask = (): RunView["plays"][number]["tasks"][number] | null => {
    const play = plays[plays.length - 1];
    return play?.tasks[play.tasks.length - 1] ?? null;
  };

  for (const ev of events) {
    if (ev.kind === "play_start") {
      plays.push({ id: summary?.plays.find((p) => p.name === ev.play)?.id ?? `p${plays.length}`, name: ev.play ?? "", tasks: [] });
      taskIndex = 0;
    } else if (ev.kind === "task_start") {
      if (plays.length === 0) plays.push({ id: `p${plays.length}`, name: ev.play ?? "", tasks: [] });
      const play = plays[plays.length - 1]!;
      const name = cleanName(ev.task ?? "");
      const facts = name.toLowerCase() === FACTS;
      // Gathering Facts is not in the summary, so it does not consume an order slot.
      const nodeId = matchNodeId(summary, play.name, name, taskIndex);
      if (!facts) taskIndex++;
      play.tasks.push({ nodeId, name, cells: {} });
    } else if (ev.kind === "host_start" && ev.host) {
      seen(ev.host);
      const t = curTask();
      if (t && run.status === "running" && (t.cells[ev.host] ?? "pending") === "pending") t.cells[ev.host] = "running";
    } else if ((ev.kind === "host_ok" || ev.kind in RESULT) && ev.host) {
      seen(ev.host);
      const t = curTask();
      if (t) t.cells[ev.host] = ev.kind === "host_ok" || isIgnoredFailure(ev) ? (ev.changed ? "changed" : "ok") : RESULT[ev.kind]!;
    } else if (ev.kind === "stats") {
      lastStats = ev;
    }
  }

  const counters = { ok: 0, changed: 0, failed: 0, unreachable: 0, skipped: 0 };
  for (const p of plays) for (const t of p.tasks) for (const c of Object.values(t.cells)) {
    if (c === "ok" || c === "changed" || c === "unreachable" || c === "skipped") counters[c]++;
    else if (c === "failed") counters.failed++;
  }
  const recap: Record<string, HostStats> | null = run.recap ?? (lastStats ? recapFromStats(lastStats) : null);
  return {
    runId: run.id, status: run.status, playbook: run.playbook, env, plays, hosts, counters, recap,
    investigations: investigations.map((i) => ({ threadId: i.threadId, host: i.host, nodeId: i.nodeId, status: i.status, summary: i.summary, permissionMode: i.permissionMode })),
    startedAt: run.startedAt, endedAt: run.endedAt, lastLine: run.lastLine,
  };
}

/**
 * Events of one matrix row, by ordinal: plays and tasks are numbered exactly as buildRunView assigns rows
 * (a `play_start` opens a play, a `task_start` opens a task, a task before any play opens an implicit play).
 */
export function eventsForRow(events: RunEventRow[], playIndex: number, taskIndex: number): RunEventRow[] {
  const out: RunEventRow[] = [];
  let play = -1;
  let task = -1;
  for (const ev of events) {
    if (ev.kind === "play_start") { play++; task = -1; }
    else if (ev.kind === "task_start") {
      if (play < 0) play = 0;
      task++;
    }
    if (play === playIndex && task === taskIndex) out.push(ev);
  }
  return out;
}

/** The row a node id occupies in the view, or null. */
export function rowOfNode(view: RunView, node: string): { playIndex: number; taskIndex: number } | null {
  for (const [playIndex, p] of view.plays.entries()) {
    const taskIndex = p.tasks.findIndex((t) => t.nodeId === node);
    if (taskIndex >= 0) return { playIndex, taskIndex };
  }
  return null;
}
