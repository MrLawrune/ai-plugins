// Thread side panel: the targets this thread touched first, then everything, with in-panel drill-down.
import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { parseTarget } from "../server/targets.ts";
import { targetFromParams } from "./directive-attrs.ts";
import { EnvBadge, StateDot } from "./badges.tsx";
import { EnvView } from "./env-view.tsx";
import { age } from "./format.ts";
import { GuestView } from "./guest-view.tsx";
import { HostView } from "./host-view.tsx";
import { useInfraQuery, useNow } from "./hooks.ts";
import { Overview } from "./overview.tsx";
import { onPanelReset } from "./panel-reset.ts";
import { withoutOwnTab } from "./panel-tab.ts";

export const PANEL_ACTION_ID = "infra";
const PLUGIN_ID = "infra";

/** Tab title that follows what the panel shows. */
function usePanelTitle(current: string | null): string {
  const parsed = current ? parseTarget(current) : null;
  const guest = useInfraQuery("guestSummary", parsed?.vmid !== undefined ? { target: current! } : null, { refreshOn: [] });
  if (!parsed) return "Infra";
  if (parsed.vmid !== undefined) return guest.data?.found ? `${guest.data.guest.name} (${parsed.vmid})` : `${parsed.node}/${parsed.vmid}`;
  return parsed.node ?? parsed.env;
}

function ThreadTargets({ threadId, onOpen }: { threadId: string; onOpen(t: string): void }) {
  const q = useInfraQuery("threadTargets", { threadId }, { refreshOn: ["infra:activity", "infra:changed"] });
  const now = useNow();
  const targets = q.data?.targets ?? [];
  if (!targets.length) return null;
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Touched by this thread</h3>
      <ul className="space-y-1">
        {targets.map((t) => (
          <li key={t.target}>
            <button type="button" onClick={() => onOpen(t.target)} className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-state-hover">
              {t.state ? <StateDot state={t.state as "running"} active={t.running} /> : null}
              <span className="min-w-0 flex-1 truncate">{t.label}</span>
              <EnvBadge env={t.env} className="hidden sm:inline-flex" />
              <span className="text-xs tabular-nums text-muted-foreground">{t.running ? "now" : age(now - t.lastAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ThreadInfraPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const nav = useBbNavigate();
  const sdk = useSdk();
  const initial = targetFromParams(params);
  const [stack, setStack] = useState<string[]>(initial ? [initial] : []);
  useEffect(() => { const t = targetFromParams(params); if (t) setStack([t]); }, [params]);
  useEffect(() => onPanelReset(({ target }) => { if (target === initial) setStack(initial ? [initial] : []); }), [initial]);
  const current = stack.at(-1) ?? null;
  const open = (t: string) => setStack((s) => [...s, t]);
  const back = () => setStack((s) => s.slice(0, -1));
  const parsed = current ? parseTarget(current) : null;

  // Re-opening this tab (same params) refreshes its title in BB's tab strip.
  const title = usePanelTitle(current);
  const shownTitle = useRef<string | null>(null);
  const ownParams = initial ? { target: initial } : undefined;
  useEffect(() => {
    if (shownTitle.current === title) return;
    shownTitle.current = title;
    nav.openThreadPanel({ actionId: PANEL_ACTION_ID, title, ...(ownParams ? { params: ownParams } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, nav]);

  const close = async () => {
    try {
      const { revision, tabs } = await sdk.threads.tabs.get({ threadId });
      await sdk.threads.tabs.update({ threadId, expectedRevision: revision, tabs: withoutOwnTab(tabs, PLUGIN_ID, PANEL_ACTION_ID, params) as typeof tabs });
    } catch (e) {
      toast.error(`Could not close the Infra tab: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        {current ? (
          <button type="button" onClick={back} className={cn("flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground")}>
            <Icon name="ChevronLeft" className="size-3.5" /> Back
          </button>
        ) : <span />}
        <button type="button" onClick={() => void close()} aria-label="Close this Infra tab" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
          <Icon name="X" className="size-3.5" /> Close
        </button>
      </div>
      {!parsed ? (
        <div className="space-y-4">
          <ThreadTargets threadId={threadId} onOpen={open} />
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Environments</h3>
            <Overview onOpen={open} compact />
          </section>
        </div>
      ) : parsed.vmid !== undefined ? <GuestView target={current!} onOpen={open} compact />
        : parsed.node !== undefined ? <HostView target={current!} onOpen={open} compact />
        : <EnvView slug={parsed.env} onOpen={open} compact />}
    </div>
  );
}
