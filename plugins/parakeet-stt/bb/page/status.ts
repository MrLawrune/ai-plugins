import { MODEL_LOADING, type HealthResult } from "../schemas.ts";

export type Tone = "ok" | "busy" | "warn" | "error";

/** One short line for the server section; null means the first check is still running. */
export function healthLine(h: HealthResult | null): { tone: Tone; text: string } {
  if (!h) return { tone: "busy", text: "Checking…" };
  if (!h.configured) return { tone: "warn", text: "Not set up" };
  // The server answered, so the URL and key are right; it just is not ready yet.
  if (!h.up && h.error === MODEL_LOADING) return { tone: "busy", text: "Loading model…" };
  if (!h.up) return { tone: "error", text: `Can't reach the server: ${h.error ?? "unknown error"}` };
  const parts = ["Connected", h.model, h.version, h.lastLatencyMs === null ? null : `${h.lastLatencyMs} ms`];
  return { tone: "ok", text: parts.filter((p) => p !== null && p !== "").join(" · ") };
}
