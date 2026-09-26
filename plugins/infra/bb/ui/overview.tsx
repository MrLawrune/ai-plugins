// All environments at a glance.
import { cn } from "@/lib/utils";
import type { EnvSummary } from "../schemas.ts";
import { EnvBadge, HealthBadge } from "./badges.tsx";
import { kindColor } from "./format.ts";
import { useInfraQuery, useNow } from "./hooks.ts";

export function EnvSummaryCard({ s, onOpen, compact }: { s: EnvSummary; onOpen(slug: string): void; compact?: boolean }) {
  const now = useNow();
  const color = kindColor(s.env.kind, s.env.color);
  return (
    <button type="button" onClick={() => onOpen(s.env.slug)} className={cn("group w-full rounded-lg border bg-card text-left transition-colors hover:bg-state-hover", compact ? "p-2.5" : "p-4")} style={{ borderLeft: `3px solid ${color}` }}>
      <div className="flex items-center justify-between gap-2">
        <EnvBadge env={s.env} />
        <HealthBadge code={s.health} staleSince={s.staleSince} now={now} />
      </div>
      <div className={cn("mt-3 grid grid-cols-3 gap-2", compact && "mt-2")}>
        <Stat label="Hosts up" value={`${s.hosts.up}/${s.hosts.total}`} warn={s.hosts.up < s.hosts.total} />
        <Stat label="Guests running" value={`${s.guests.running}/${s.guests.total}`} />
        <Stat label="Agents active" value={String(s.activeThreads.length)} highlight={s.activeThreads.length > 0} />
      </div>
    </button>
  );
}

function Stat({ label, value, warn, highlight }: { label: string; value: string; warn?: boolean; highlight?: boolean }) {
  return (
    <div>
      <div className={cn("text-lg font-semibold tabular-nums", warn && "text-amber-600 dark:text-amber-400", highlight && "text-emerald-600 dark:text-emerald-400")}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export function Overview({ onOpen, compact }: { onOpen(target: string): void; compact?: boolean }) {
  const q = useInfraQuery("overview", {}, { refreshOn: ["infra:changed", "infra:activity"] });
  if (q.error && !q.data) return <p className="text-sm text-destructive">{q.error}</p>;
  if (q.data && !q.data.envs.length) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No environments yet. Add your Proxmox hosts under Settings → Plugins → Infra.
      </div>
    );
  }
  return <div className={cn("grid gap-3", !compact && "md:grid-cols-2")}>{(q.data?.envs ?? []).map((s) => <EnvSummaryCard key={s.env.slug} s={s} onOpen={onOpen} compact={compact} />)}</div>;
}
