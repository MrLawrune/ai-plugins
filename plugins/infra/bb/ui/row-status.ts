// Content script: captures the host's row-status setter; the overlay (which has hooks) drives it.
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

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

/** Mark exactly these threads as working on infra; clear the rest this plugin marked. */
export function applyRunning(running: Map<string, string[]>): void {
  if (!setter) return;
  for (const id of [...applied]) {
    if (!running.has(id)) { setter(id, null); applied.delete(id); }
  }
  for (const [id, targets] of running) {
    setter(id, { icon: "infra-stack" as never, label: `Working on ${targets.slice(0, 3).join(", ")}${targets.length > 3 ? "…" : ""}`, tone: "running" });
    applied.add(id);
  }
}
