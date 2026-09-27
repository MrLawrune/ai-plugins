// Target addressing: <env>, <env>/<path>, <env>/<path>#<node>; runs: run_<id>[/<host>/<node>].
export const SLUG_RE = /^[a-z0-9-]{1,32}$/;
export const NODE_RE = /^p\d+(\/(t\d+(\/t\d+)*|r[A-Za-z0-9_.-]+|h\d+))?$/;
const RUN_ID_RE = /^run_[0-9A-Za-z]{6,32}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type Target = { env: string; path?: string; node?: string };

export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("//")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function parseTarget(s: string): Target | null {
  const [head, ...nodeParts] = s.split("#");
  if (nodeParts.length > 1) return null;
  const slash = head!.indexOf("/");
  const env = slash === -1 ? head! : head!.slice(0, slash);
  if (!SLUG_RE.test(env)) return null;
  const out: Target = { env };
  if (slash !== -1) {
    const path = head!.slice(slash + 1);
    if (!isSafeRelativePath(path)) return null;
    out.path = path;
  }
  if (nodeParts.length === 1) {
    if (!out.path || !NODE_RE.test(nodeParts[0]!)) return null;
    out.node = nodeParts[0]!;
  }
  return out;
}

export const formatTarget = (t: Target): string => `${t.env}${t.path ? `/${t.path}` : ""}${t.node ? `#${t.node}` : ""}`;

export function parseRunRef(s: string): { runId: string; host?: string; node?: string } | null {
  const [runId, host, ...rest] = s.split("/");
  if (!runId || !RUN_ID_RE.test(runId)) return null;
  if (host === undefined) return { runId };
  const node = rest.join("/");
  if (!HOST_RE.test(host) || !NODE_RE.test(node)) return null;
  return { runId, host, node };
}
