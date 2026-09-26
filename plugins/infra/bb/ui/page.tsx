// The Infra nav page: breadcrumbs + overview / environment / host / guest, plus header and sidebar accessory.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ActivityFeed } from "./activity-feed.tsx";
import { EnvView } from "./env-view.tsx";
import { GuestView } from "./guest-view.tsx";
import { HostView } from "./host-view.tsx";
import { useInfraQuery } from "./hooks.ts";
import { Overview } from "./overview.tsx";
import { parseSubPath, type Route } from "./route.ts";

export const PANEL_PATH = "infra";

function Crumbs({ route, go }: { route: Route; go(subPath: string): void }) {
  const parts: { label: string; sub: string }[] = [{ label: "Environments", sub: "" }];
  if (route.view !== "overview") parts.push({ label: route.slug, sub: route.slug });
  if (route.view === "host" || route.view === "guest") parts.push({ label: route.node, sub: `${route.slug}/${route.node}` });
  if (route.view === "guest") parts.push({ label: String(route.vmid), sub: route.target });
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      {parts.map((p, i) => (
        <span key={p.sub} className="flex items-center gap-1">
          {i ? <Icon name="ChevronRight" className="size-3.5" /> : null}
          {i === parts.length - 1 ? <span className="text-foreground">{p.label}</span> : <button type="button" className="hover:text-foreground hover:underline" onClick={() => go(p.sub)}>{p.label}</button>}
        </span>
      ))}
    </nav>
  );
}

export function InfraPage({ subPath }: { subPath: string }) {
  const nav = useBbNavigate();
  const route = parseSubPath(subPath);
  const go = (sub: string) => nav.toPluginPanel(PANEL_PATH, { subPath: sub });
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <Crumbs route={route} go={go} />
        {route.view === "overview" ? (
          <div className="space-y-6">
            <Overview onOpen={go} />
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent activity across environments</h3>
              <ActivityFeed onOpenTarget={go} />
            </section>
          </div>
        ) : route.view === "env" ? <EnvView slug={route.slug} onOpen={go} />
          : route.view === "host" ? <HostView target={route.target} onOpen={go} />
          : <GuestView target={route.target} onOpen={go} />}
      </div>
    </div>
  );
}

export function ActivityTab() {
  const nav = useBbNavigate();
  return (
    <div className="h-full overflow-y-auto p-3">
      <ActivityFeed compact onOpenTarget={(t) => nav.toPluginPanel(PANEL_PATH, { subPath: t })} />
    </div>
  );
}

export function InfraHeader() {
  const q = useInfraQuery("overview", {}, { refreshOn: ["infra:changed"] });
  const bad = (q.data?.envs ?? []).filter((e) => e.health !== "ok").length;
  return (
    <div className="flex items-center gap-2 text-xs">
      {bad ? <span className="text-amber-600 dark:text-amber-400">{bad} environment{bad > 1 ? "s" : ""} degraded</span> : null}
      <Button variant="ghost" size="sm" onClick={q.refresh} aria-label="Refresh"><Icon name="ArrowReloadHorizontal" className="size-4" /></Button>
    </div>
  );
}

/** Sidebar row accessory: running guests ▲ and hosts down ▼ across all environments. */
export function InfraAccessory() {
  const q = useInfraQuery("overview", {}, { refreshOn: ["infra:changed"] });
  const envs = q.data?.envs ?? [];
  if (!envs.length) return null;
  const running = envs.reduce((n, e) => n + e.guests.running, 0);
  const down = envs.reduce((n, e) => n + (e.hosts.total - e.hosts.up), 0) + envs.filter((e) => e.health !== "ok").length;
  return (
    <span className="truncate text-xs tabular-nums text-muted-foreground" aria-label={`${running} guests running, ${down} problems`}>
      ▲{running}{down ? <span className="text-amber-600 dark:text-amber-400"> ▼{down}</span> : null}
    </span>
  );
}
