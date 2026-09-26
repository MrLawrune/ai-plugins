// One environment: host cards, then a searchable guest table.
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { EnvViewDto, HostState } from "../schemas.ts";
import { AskAgentMenu } from "./ask-agent.tsx";
import { EnvBadge, HealthBadge, StateDot, UsageBar } from "./badges.tsx";
import { age, bytes, pct } from "./format.ts";
import { useInfraQuery, useNow } from "./hooks.ts";
import { ActivityList } from "./activity-feed.tsx";

type Guest = EnvViewDto["guests"][number];
type SortKey = "vmid" | "name" | "state" | "cpu" | "mem";

export function HostCard({ slug, h, onOpen, compact }: { slug: string; h: HostState; onOpen(target: string): void; compact?: boolean }) {
  return (
    <button type="button" onClick={() => onOpen(`${slug}/${h.node}`)} className="w-full space-y-2 rounded-lg border bg-card p-3 text-left hover:bg-state-hover">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium"><StateDot state={h.online ? "online" : "offline"} />{h.node}</span>
        <span className="truncate text-xs text-muted-foreground">{h.ip ?? ""}{h.online ? ` · up ${age(h.uptime * 1000)}` : " · offline"}</span>
      </div>
      {h.online && !compact ? (
        <div className="grid gap-1.5">
          <UsageBar label={`CPU · ${h.maxcpu} threads`} used={h.cpu} total={1} />
          <UsageBar label={`Memory · ${bytes(h.mem)} of ${bytes(h.maxmem)}`} used={h.mem} total={h.maxmem} />
          <UsageBar label={`Root disk · ${bytes(h.disk)} of ${bytes(h.maxdisk)}`} used={h.disk} total={h.maxdisk} />
        </div>
      ) : null}
    </button>
  );
}

function sortGuests(guests: Guest[], key: SortKey): Guest[] {
  const order = { running: 0, paused: 1, unknown: 2, stopped: 3 };
  return [...guests].sort((a, b) => {
    if (key === "name") return a.name.localeCompare(b.name);
    if (key === "state") return order[a.state] - order[b.state] || a.vmid - b.vmid;
    if (key === "cpu") return b.cpu - a.cpu;
    if (key === "mem") return pct(b.mem, b.maxmem) - pct(a.mem, a.maxmem);
    return a.vmid - b.vmid;
  });
}

export function GuestTable({ guests, onOpen, compact }: { guests: Guest[]; onOpen(target: string, g: Guest): void; compact?: boolean }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("vmid");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortGuests(guests.filter((g) => !g.template && (!q || `${g.vmid} ${g.name} ${g.node} ${g.ips.join(" ")} ${g.tags.join(" ")} ${g.type}`.toLowerCase().includes(q))), sort);
  }, [guests, query, sort]);
  const th = (k: SortKey, label: string, cls = "") => (
    <th className={cn("px-2 py-1.5 text-left font-medium", cls)}>
      <button type="button" className={cn("hover:text-foreground", sort === k && "text-foreground")} onClick={() => setSort(k)}>{label}</button>
    </th>
  );
  return (
    <div className="space-y-2">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name, ID, IP, tag…" className="h-8" />
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full whitespace-nowrap text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>{th("vmid", "ID")}{th("name", "Name")}{compact ? null : <th className="px-2 py-1.5 text-left font-medium">Host</th>}{th("state", "State")}<th className="px-2 py-1.5 text-left font-medium">IP</th>{compact ? null : th("cpu", "CPU", "text-right")}{compact ? null : th("mem", "Mem", "text-right")}</tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((g) => (
              <tr key={`${g.node}/${g.vmid}`} className="cursor-pointer hover:bg-state-hover" onClick={() => onOpen(`${g.node}/${g.vmid}`, g)}>
                <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{g.vmid}</td>
                <td className="max-w-[16rem] truncate px-2 py-1.5 font-medium">
                  <span className="inline-flex items-center gap-2">{g.name}<span className="text-xs font-normal text-muted-foreground">{g.type === "qemu" ? "VM" : "CT"}</span>{g.active ? <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400" title="An agent touched this recently">● agent</span> : null}</span>
                </td>
                {compact ? null : <td className="px-2 py-1.5 text-muted-foreground">{g.node}</td>}
                <td className="px-2 py-1.5"><span className="inline-flex items-center gap-1.5"><StateDot state={g.state} active={g.active} />{g.state}</span></td>
                <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground" title={g.ips.join("\n") || undefined}>{g.ips[0] ?? "—"}{g.ips.length > 1 ? <span className="ml-1.5 rounded bg-muted px-1 font-sans text-[11px]">+{g.ips.length - 1}</span> : null}</td>
                {compact ? null : <td className="px-2 py-1.5 text-right tabular-nums">{g.state === "running" ? `${(g.cpu * 100).toFixed(g.cpu < 0.1 ? 1 : 0)}%` : "—"}</td>}
                {compact ? null : <td className="px-2 py-1.5 text-right tabular-nums">{g.state === "running" ? `${bytes(g.mem)}` : "—"}</td>}
              </tr>
            ))}
            {!shown.length ? <tr><td colSpan={7} className="px-2 py-6 text-center text-muted-foreground">No matching guests</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function EnvView({ slug, onOpen, compact }: { slug: string; onOpen(target: string): void; compact?: boolean }) {
  const q = useInfraQuery("env", { slug }, { refreshOn: ["infra:changed", "infra:activity"] });
  const now = useNow();
  if (q.error && !q.data) return <p className="text-sm text-destructive">{q.error}</p>;
  if (!q.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!q.data.found) return <p className="text-sm text-muted-foreground">Environment “{slug}” was not found.</p>;
  const v = q.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3"><EnvBadge env={v.env} /><HealthBadge code={v.health} staleSince={v.connections.map((c) => c.health.staleSince).filter((x): x is number => x !== null)[0] ?? null} now={now} /></div>
        <AskAgentMenu target={slug} kind="env" />
      </div>
      {v.connections.filter((c) => c.health.code !== "ok").map((c) => (
        <p key={c.id} className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">{c.label}: {c.health.code}{c.health.message ? ` — ${c.health.message}` : ""}</p>
      ))}
      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Hosts</h3>
        <div className={cn("grid gap-2", !compact && "md:grid-cols-2 xl:grid-cols-3")}>{v.hosts.map((h) => <HostCard key={h.node} slug={slug} h={h} onOpen={onOpen} compact={compact} />)}</div>
      </section>
      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Guests</h3>
        <GuestTable guests={v.guests} onOpen={(t) => onOpen(`${slug}/${t}`)} compact={compact} />
      </section>
      {!compact ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent agent activity</h3>
          <ActivityList items={v.recentActivity} changes={[]} onOpenTarget={onOpen} />
        </section>
      ) : null}
    </div>
  );
}
