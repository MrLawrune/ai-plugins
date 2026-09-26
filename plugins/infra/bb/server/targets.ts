// Target addressing: <env>, <env>/<node>, <env>/<node>/<vmid>.
export const SLUG_RE = /^[a-z0-9-]{1,32}$/;
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
const VMID_RE = /^[1-9][0-9]{0,8}$/;

export type TargetPath = { env: string; node?: string; vmid?: number };

export function parseTarget(s: string): TargetPath | null {
  const parts = s.split("/");
  if (parts.length > 3 || !SLUG_RE.test(parts[0]!)) return null;
  const out: TargetPath = { env: parts[0]! };
  if (parts.length >= 2) {
    if (!NODE_RE.test(parts[1]!)) return null;
    out.node = parts[1]!;
  }
  if (parts.length === 3) {
    if (!VMID_RE.test(parts[2]!)) return null;
    out.vmid = Number(parts[2]);
  }
  return out;
}

export function formatTarget(t: TargetPath): string {
  return [t.env, t.node, t.vmid].filter((p) => p !== undefined).join("/");
}
