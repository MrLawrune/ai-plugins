// Pure helpers for the dispatch actions: mention pill labels, parse-error wording, and context size display.
const LABEL_MAX = 80;
const ERROR_MAX = 100;

/** Basename of a target ref's path ("lab/site.yml#p0/t1" → "site.yml"); null for env-only and run refs. */
function fileOf(target: string): string | null {
  if (target.startsWith("run_")) return null;
  const path = target.split("#")[0]!.split("/").slice(1).join("/");
  return path ? path.split("/").pop() ?? path : null;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Pill text: "<file> › <step>" when the step's plain text is known, otherwise the ref itself. */
export function mentionLabel(target: string, plain?: string | null): string {
  const text = (plain ?? "").trim();
  const file = fileOf(target);
  return text && file ? `${file} › ${clip(text, LABEL_MAX)}` : target;
}

export function parseErrorLabel(file: string, err: { line: number; message: string }): string {
  return `${file} (parse error line ${err.line}: ${clip(err.message, ERROR_MAX)})`;
}

export function fixInstruction(file: string, err: { line: number; message: string }): string {
  return `Fix the YAML parse error in ${file} at line ${err.line}: ${clip(err.message, ERROR_MAX)}`;
}

export const promptBytes = (s: string): number => new TextEncoder().encode(s).length;

export function contextSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** What the server appends for a non-empty instruction, so the dialog's size estimate matches the real prompt. */
export function withInstruction(context: string, instruction: string): string {
  const text = instruction.trim();
  return text ? `${context}\ninstruction: ${text}` : context;
}

/** Toast after Investigate: says plainly when the host refused read-only and the thread will ask for approvals. */
export function investigateToast(mode: string): string {
  return mode === "readonly" ? "Investigating in a new thread (read-only)" : `Investigating in a new thread (${mode}: approvals required)`;
}

/** The run card / run view line for one investigation; the effective permission mode is shown when known. */
export function investigationLine(i: { threadId: string; status: string; summary: string | null; permissionMode: string | null }): string {
  const mode = i.permissionMode ? ` (${i.permissionMode === "readonly" ? "read-only" : i.permissionMode})` : "";
  if (i.status === "running") return `investigating in @thread:${i.threadId}${mode}`;
  return `investigated in @thread:${i.threadId}${mode}${i.summary ? `: ${i.summary.split("\n")[0]}` : ""}`;
}
