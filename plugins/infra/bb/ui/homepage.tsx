// New-thread screen: one line of health per environment.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { EnvBadge, HealthBadge } from "./badges.tsx";
import { useInfraQuery, useNow } from "./hooks.ts";
import { PANEL_PATH } from "./page.tsx";

export function HomepageStrip() {
  const q = useInfraQuery("overview", {}, { refreshOn: ["infra:changed", "infra:activity"] });
  const nav = useBbNavigate();
  const now = useNow();
  const envs = q.data?.envs ?? [];
  if (!envs.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {envs.map((s) => (
        <button key={s.env.slug} type="button" onClick={() => nav.toPluginPanel(PANEL_PATH, { subPath: s.env.slug })} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left text-xs hover:bg-state-hover">
          <EnvBadge env={s.env} />
          <span className="tabular-nums text-muted-foreground">{s.guests.running}/{s.guests.total} running</span>
          {s.activeThreads.length ? <span className="text-emerald-600 dark:text-emerald-400">{s.activeThreads.length} agent{s.activeThreads.length > 1 ? "s" : ""} active</span> : null}
          <HealthBadge code={s.health} staleSince={s.staleSince} now={now} />
        </button>
      ))}
    </div>
  );
}
