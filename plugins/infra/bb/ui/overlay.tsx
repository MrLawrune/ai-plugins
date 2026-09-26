// App-wide overlay (no UI of its own): inventory-change toasts and sidebar row status for running agents.
import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { EventsSignal } from "../schemas.ts";
import { CHANNELS } from "../shared/constants.ts";
import { useInfraQuery } from "./hooks.ts";
import { PANEL_PATH } from "./page.tsx";
import { applyStatuses, onSetterReady } from "./row-status.ts";

const VERB = { "guest.added": "created", "guest.removed": "removed", "guest.state": "", "host.state": "" } as const;
const TOAST_DEBOUNCE_MS = 2000;

/** Set by the always-mounted overlay so palette commands (which run outside React) can navigate in-app. */
let openInfraPanel: ((subPath: string) => void) | null = null;
export function navigateToInfra(subPath = ""): void {
  if (openInfraPanel) openInfraPanel(subPath);
  else window.location.assign(`/plugins/infra/${PANEL_PATH}${subPath ? `/${subPath}` : ""}`);
}

export function InfraOverlay() {
  const nav = useBbNavigate();
  useEffect(() => {
    openInfraPanel = (subPath) => nav.toPluginPanel(PANEL_PATH, { subPath });
    return () => { openInfraPanel = null; };
  }, [nav]);
  const q = useInfraQuery("threadStatuses", {}, { refreshOn: [CHANNELS.activity], intervalMs: 60_000 });
  const [ready, setReady] = useState(0);
  useEffect(() => onSetterReady(() => setReady((n) => n + 1)), []);
  useEffect(() => {
    applyStatuses(q.data?.threads ?? []);
  }, [q.data, ready]);

  const pending = useRef(new Map<string, { events: EventsSignal["events"]; timer: ReturnType<typeof setTimeout> }>());
  useEffect(() => () => { for (const p of pending.current.values()) clearTimeout(p.timer); }, []);
  useRealtime(CHANNELS.events, (payload) => {
    const events = (payload as EventsSignal | null)?.events;
    if (!Array.isArray(events)) return;
    for (const e of events) {
      const slug = e.env.slug;
      const entry = pending.current.get(slug) ?? { events: [], timer: setTimeout(() => flush(slug), TOAST_DEBOUNCE_MS) };
      entry.events.push(e);
      pending.current.set(slug, entry);
    }
  });

  function flush(slug: string) {
    const entry = pending.current.get(slug);
    pending.current.delete(slug);
    if (!entry?.events.length) return;
    const first = entry.events[0]!;
    const describe = (e: EventsSignal["events"][number]) => `${e.target.split("/").slice(1).join("/")} ${VERB[e.kind] || e.detail}${VERB[e.kind] && e.detail ? ` (${e.detail})` : ""}`;
    const title = `${first.env.name}: ${entry.events.length === 1 ? describe(first) : `${entry.events.length} changes`}`;
    const description = entry.events.length > 1 ? entry.events.slice(0, 4).map(describe).join(" · ") : first.threadId ? "Likely caused by an agent thread" : undefined;
    const tone = entry.events.some((e) => e.kind === "host.state" || e.detail.endsWith("→ stopped")) && first.env.kind === "prod" ? toast.warning : toast;
    tone(title, {
      description,
      action: { label: first.threadId ? "Open thread" : "View", onClick: () => (first.threadId ? nav.toThread(first.threadId) : nav.toPluginPanel(PANEL_PATH, { subPath: first.target })) },
    });
  }

  return null;
}
