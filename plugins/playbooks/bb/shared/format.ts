// Pure display formatters. No Node or zod imports: the browser bundle loads this.
import type { CellState, RunStatus, RunView } from "./types.ts";

export type Glyph = "✓" | "~" | "✗" | "!" | "–" | "◐" | "·";

const GLYPHS: Record<CellState, Glyph> = { ok: "✓", changed: "~", failed: "✗", unreachable: "!", skipped: "–", running: "◐", pending: "·" };
export const glyph = (state: CellState): Glyph => GLYPHS[state];

const STATUS_GLYPH: Record<RunStatus, string> = { queued: "·", starting: "◐", running: "◐", success: "✓", failed: "✗", canceled: "–", unknown: "!" };
const STATUS_LABEL: Record<RunStatus, string> = { queued: "Queued", starting: "Starting", running: "Running", success: "Success", failed: "Failed", canceled: "Canceled", unknown: "Unknown" };
export const statusGlyph = (s: RunStatus): string => STATUS_GLYPH[s];
export const statusLabel = (s: RunStatus): string => STATUS_LABEL[s];

/** Text mode names role tasks `<role> : <task>`; runner events carry the bare name. */
export const cleanName = (name: string): string => name.replace(/^[^:]*?\s:\s+/, "").trim();

/** Compact relative age: "4s", "2m", "3h", "2d". */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Duration of a run; live against `now` while it has not ended. */
export function elapsed(startedAt: number | null, endedAt: number | null, now: number): string {
  if (startedAt === null) return "–";
  const s = Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * One-line run summary (L0). The view does not carry the inventory or check flag,
 * so callers that know them pass `meta`; play/task position is derived from the matrix.
 */
export function l0Line(view: RunView, _now: number, meta?: { inventory: string; check: boolean }): string {
  let total = 0;
  let current = 0;
  let playIdx = 0;
  for (const [pi, play] of view.plays.entries()) {
    for (const t of play.tasks) {
      total++;
      if (Object.values(t.cells).some((c) => c !== "pending")) { current = total; playIdx = pi + 1; }
    }
  }
  let line = `${statusGlyph(view.status)} ${statusLabel(view.status)}  ◆${view.env.slug} ${view.playbook}`;
  if (meta) line += ` → ${meta.inventory}${meta.check ? " (check)" : ""}`;
  if (view.plays.length > 0) line += ` · play ${playIdx}/${view.plays.length} · task ${current}/${total}`;
  return line;
}
