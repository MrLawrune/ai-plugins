// Frontend formatting. Byte/percent/age helpers are shared with the server.
import type { EnvKind, HealthCode, RunState } from "../schemas.ts";
import { age } from "../shared/format.ts";

export { age, bytes, pct } from "../shared/format.ts";

export const PROD_COLOR = "#ef4444";
const FALLBACK_COLOR = "#64748b";

export function kindColor(kind: EnvKind, color: string): string {
  if (kind === "prod") return PROD_COLOR;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : FALLBACK_COLOR;
}

export function stateTone(state: RunState): "ok" | "off" | "warn" {
  if (state === "running") return "ok";
  if (state === "stopped") return "off";
  return "warn";
}

const HEALTH: Record<HealthCode, string> = {
  ok: "Healthy",
  "auth-failed": "Sign-in failed",
  unreachable: "Unreachable",
  "tls-mismatch": "Certificate changed",
  degraded: "Degraded",
  disabled: "Disabled",
};

export function healthLabel(code: HealthCode, staleSince: number | null, now: number): string {
  return staleSince === null ? HEALTH[code] : `${HEALTH[code]} · stale ${age(now - staleSince)}`;
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "env";
}

export const KIND_DEFAULT_COLORS: Record<EnvKind, string> = {
  lab: "#22c55e", dev: "#3b82f6", staging: "#f59e0b", prod: PROD_COLOR, customer: "#a855f7", other: "#64748b",
};
