// Directive attributes are model-written and untrusted: accept only well-formed values.
import { NODE_RE, isSafeRelativePath, SLUG_RE } from "../server/targets.ts";

const RUN_ID_RE = /^run_[0-9A-Za-z]{6,32}$/;
const PLAY_RE = /^p\d+$/;

export type PlaybookAttrs = { env: string; file: string; play: string | null; run: string | null };

export function parsePlaybookAttrs(attrs: Readonly<Record<string, string>>): PlaybookAttrs | null {
  const { env, file, play, run } = attrs;
  if (env === undefined || file === undefined || !SLUG_RE.test(env) || !isSafeRelativePath(file) || file.length > 300) return null;
  if (play !== undefined && !(PLAY_RE.test(play) && NODE_RE.test(play))) return null;
  if (run !== undefined && !RUN_ID_RE.test(run)) return null;
  return { env, file, play: play ?? null, run: run ?? null };
}

const SIMPLE_WHEN = /^[\w.\[\]'"-]+(\s+(==|!=)\s+[\w.\[\]'"-]+|\s+is\s+(not\s+)?defined)$/;

/** `when` in plain words for simple conditions (==, !=, is [not] defined); anything richer stays as written. */
export function whenText(when: string): string {
  const w = when.trim();
  return SIMPLE_WHEN.test(w) && !/\b(and|or|not\s+in|in)\b/.test(w.replace(/\bis\s+not\s+defined\b/, "")) ? `only if ${w}` : `when: ${w}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 plays · webservers, dbservers · 9 steps · 1 handler" */
export function countsLine(c: { plays: number; steps: number; handlers: number }, targets: string[]): string {
  const parts = [plural(c.plays, "play")];
  if (targets.length) parts.push(targets.join(", "));
  parts.push(plural(c.steps, "step"));
  if (c.handlers) parts.push(plural(c.handlers, "handler"));
  return parts.join(" · ");
}
