// Content script: captures the host's row-status setter; the overlay (which has hooks) drives it.
// Statuses expire after 30 minutes on the server; the overlay re-queries every minute to drop them.
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import type { ThreadStatusDto } from "../schemas.ts";

type Setter = NonNullable<PluginContentScriptContext["experimental_setThreadRowStatus"]>;
let setter: Setter | null = null;
const applied = new Set<string>();
const listeners = new Set<() => void>();

export function mountRowStatus(ctx: PluginContentScriptContext): () => void {
  setter = ctx.experimental_setThreadRowStatus ?? null;
  listeners.forEach((l) => l());
  return () => {
    for (const id of applied) setter?.(id, null);
    applied.clear();
    setter = null;
  };
}

export function onSetterReady(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const TONE = { running: "running", ok: "success", failed: "error" } as const;
const VERB = { running: "Working on", ok: "Worked on", failed: "Last command failed on" } as const;

/** Mark exactly these threads; clear the rest this plugin marked. BB shows it once a thread is no longer busy. */
export function applyStatuses(threads: ThreadStatusDto[]): void {
  if (!setter) return;
  const next = new Set(threads.map((t) => t.threadId));
  for (const id of [...applied]) {
    if (!next.has(id)) { setter(id, null); applied.delete(id); }
  }
  for (const t of threads) {
    const names = `${t.labels.slice(0, 3).join(", ")}${t.labels.length > 3 ? "…" : ""}`;
    setter(t.threadId, { icon: "infra-stack", label: `Infra: ${VERB[t.state]} ${names}`, tone: TONE[t.state] });
    applied.add(t.threadId);
  }
}
