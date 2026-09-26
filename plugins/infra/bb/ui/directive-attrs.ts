// Directive attributes are model-written and untrusted: accept only well-formed targets.
import { formatTarget, parseTarget } from "../server/targets.ts";

export function parseDirectiveAttrs(kind: "guest" | "host", attrs: Readonly<Record<string, string>>): string | null {
  const env = attrs.env ?? "";
  const rest = kind === "guest" ? attrs.id ?? "" : attrs.node ?? "";
  const t = parseTarget(`${env}/${rest}`);
  if (!t) return null;
  if (kind === "guest" && t.vmid === undefined) return null;
  if (kind === "host" && (t.node === undefined || t.vmid !== undefined)) return null;
  return formatTarget(t);
}

/** Thread panel params round-trip through persistence: accept only `{ target }` with a well-formed target. */
export function targetFromParams(params: unknown): string | null {
  const t = params && typeof params === "object" && !Array.isArray(params) ? (params as { target?: unknown }).target : null;
  return typeof t === "string" && parseTarget(t) ? t : null;
}
