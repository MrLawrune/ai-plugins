// Panel params are persisted and model-influenced: accept only well-formed values, else show the root.
import { parseTarget } from "../server/targets.ts";

const RUN_ID_RE = /^run_[0-9A-Za-z]{6,32}$/;

export type PanelView =
  | { kind: "root" }
  | { kind: "playbook"; target: string; view: "list" | "graph" | null; run: boolean }
  | { kind: "run"; runId: string };

export function panelParams(params: unknown): PanelView {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return { kind: "root" };
  const p = params as Record<string, unknown>;
  if (typeof p.runId === "string") return RUN_ID_RE.test(p.runId) ? { kind: "run", runId: p.runId } : { kind: "root" };
  if (typeof p.target === "string" && p.target.length <= 400) {
    const t = parseTarget(p.target);
    if (t?.path) return { kind: "playbook", target: p.target, view: p.view === "list" || p.view === "graph" ? p.view : null, run: p.run === true };
  }
  return { kind: "root" };
}
