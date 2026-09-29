import type { KokoroStatus } from "../schemas.ts";

export type Tone = "ok" | "busy" | "warn" | "error";

/** One short line for the header and the server section. */
export function statusLine(s: KokoroStatus | null): { tone: Tone; text: string } {
  if (!s) return { tone: "busy", text: "Checking…" };
  const { setup, health } = s;
  switch (setup.state) {
    case "checking":
      return { tone: "busy", text: "Checking…" };
    case "needs-uv":
      return { tone: "warn", text: "Needs uv" };
    case "downloading-models":
      return { tone: "busy", text: `Downloading voice model${setup.progress !== null ? ` ${Math.round(setup.progress * 100)}%` : ""}` };
    case "installing-runtime":
      return { tone: "busy", text: "Installing runtime" };
    case "starting":
      return { tone: "busy", text: "Starting" };
    case "error":
      // With Manage server off, a stopped server is the user's choice.
      return health.up ? { tone: "ok", text: "Ready" } : { tone: "warn", text: "Not running" };
    default:
      if (!health.up) return { tone: "error", text: "Not responding" };
      return health.health.muted ? { tone: "warn", text: "Muted" } : { tone: "ok", text: "Ready" };
  }
}

export function ownerText(s: KokoroStatus): string | null {
  if (s.setup.state === "running") return "Managed by bb";
  if (s.setup.state !== "external" || !s.health.up) return null;
  switch (s.health.health.started_by) {
    case "bb":
      return "Started by an earlier bb session";
    default:
      return "Started outside bb";
  }
}
