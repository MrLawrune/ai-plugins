// Pure view-model helpers for the run matrix.
import { cleanName } from "../shared/format.ts";
import type { CellState, RunView } from "../shared/types.ts";

type Task = RunView["plays"][number]["tasks"][number];

const BAD = new Set<CellState>(["failed", "unreachable"]);

/** Hosts with at least one failed or unreachable cell, in the run's host order. */
export function failedHosts(view: RunView): string[] {
  const bad = new Set<string>();
  for (const p of view.plays) for (const t of p.tasks) for (const [h, s] of Object.entries(t.cells)) if (BAD.has(s)) bad.add(h);
  return view.hosts.filter((h) => bad.has(h));
}

/** One glyph for the task row: worst state wins. */
export function taskState(t: Task): CellState {
  const states = Object.values(t.cells);
  for (const s of ["failed", "unreachable", "running", "changed", "ok", "skipped"] as const) if (states.includes(s)) return s;
  return "pending";
}

export const playFailed = (p: RunView["plays"][number]): boolean => p.tasks.some((t) => Object.values(t.cells).some((s) => BAD.has(s)));

export const taskKey = (play: string, task: string): string => `${play}\u0000${task}`;

/** First failure message per host under each play/task (ignored failures excluded), from `run.events` (failedOnly), keyed by play and task name. */
export function failureMessages(events: { play: string | null; task: string | null; host: string | null; msg: string | null; kind?: string; failed?: boolean }[]): Map<string, { host: string; msg: string }[]> {
  const out = new Map<string, { host: string; msg: string }[]>();
  for (const e of events) {
    if (e.play === null || !e.task || !e.host || !e.msg) continue;
    if (e.kind === "host_failed" && e.failed === false) continue; // ignore_errors: carried on, not a failure
    const key = taskKey(e.play, cleanName(e.task));
    const list = out.get(key) ?? [];
    if (!list.some((x) => x.host === e.host)) list.push({ host: e.host, msg: e.msg });
    out.set(key, list);
  }
  return out;
}

export const recapLine = (c: RunView["counters"]): string =>
  `ok ${c.ok} · changed ${c.changed} · failed ${c.failed} · unreachable ${c.unreachable} · skipped ${c.skipped}`;

/** Failed cells plus unreachable ones, the number shown as "failed" on the card and the view. */
export const failedCount = (c: RunView["counters"]): number => c.failed + c.unreachable;
