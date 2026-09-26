// One LXC or VM: overview, metrics, storage/snapshots/backups, tasks, agent activity.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MetricRange } from "../schemas.ts";
import { ActivityList } from "./activity-feed.tsx";
import { AskAgentMenu } from "./ask-agent.tsx";
import { EnvBadge, StateDot, UsageBar } from "./badges.tsx";
import { age, bytes } from "./format.ts";
import { useInfraQuery, useNow } from "./hooks.ts";
import { MetricsPanel } from "./metrics-panel.tsx";
import { TaskList } from "./tasks.tsx";

const DISK_KEY = /^(rootfs|mp\d+|scsi\d+|virtio\d+|sata\d+|ide\d+|efidisk\d+)$/;
const NET_KEY = /^net\d+$/;
const SUMMARY_KEYS = ["cores", "memory", "swap", "ostype", "onboot", "unprivileged", "features", "cpu", "bios", "agent", "nameserver", "searchdomain"];

function Extras({ target, tab }: { target: string; tab: "tasks" | "backups" }) {
  const q = useInfraQuery("guestExtras", { target, tab }, { refreshOn: [] });
  const now = useNow();
  if (q.error) return <p className="text-sm text-destructive">{q.error}</p>;
  if (!q.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!q.data.found) return null;
  if (tab === "tasks") return <TaskList tasks={q.data.tasks ?? []} />;
  const backups = q.data.backups ?? [];
  if (!backups.length) return <p className="py-4 text-center text-sm text-muted-foreground">No backups found on this host's backup storages.</p>;
  return (
    <ul className="divide-y text-sm">
      {backups.map((b) => (
        <li key={b.volid} className="flex items-center gap-3 py-1.5">
          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{age(now - b.ctime * 1000)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={b.volid}>{b.volid.split("/").pop()}</span>
          <span className="text-xs text-muted-foreground">{b.storage} · {bytes(b.size)}{b.notes ? ` · ${b.notes}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

export function GuestView({ target, onOpen, compact }: { target: string; onOpen(target: string): void; compact?: boolean }) {
  const q = useInfraQuery("guest", { target }, { refreshOn: ["infra:changed", "infra:activity"] });
  const nav = useBbNavigate();
  const [range, setRange] = useState<MetricRange>("hour");
  if (q.error && !q.data) return <p className="text-sm text-destructive">{q.error}</p>;
  if (!q.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!q.data.found) return <p className="text-sm text-muted-foreground">{target} is not in the current inventory. It may have been removed.</p>;
  const { detail, env, webUrl } = q.data;
  const g = detail.guest;
  const running = g.state === "running";
  const disks = Object.entries(detail.config).filter(([k]) => DISK_KEY.test(k));
  const nets = Object.entries(detail.config).filter(([k]) => NET_KEY.test(k));
  const summary = SUMMARY_KEYS.filter((k) => detail.config[k] !== undefined).map((k) => [k, detail.config[k]!] as const);
  const host = target.split("/").slice(0, 2).join("/");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-lg font-semibold"><StateDot state={g.state} />{g.name}<span className="text-sm font-normal text-muted-foreground">{g.type === "qemu" ? "VM" : "CT"} {g.vmid}</span></div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <EnvBadge env={env} />
            <button type="button" className="hover:underline" onClick={() => onOpen(host)}>on {g.node}</button>
            <span>{g.state}{running ? ` · up ${age(g.uptime * 1000)}` : ""}</span>
            {detail.os ? <span>{detail.os}</span> : null}
            {g.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5">{t}</span>)}
          </div>
        </div>
        <div className="flex gap-2">
          <AskAgentMenu target={target} kind="guest" size={compact ? "icon" : "sm"} />
          <Button variant="ghost" size="sm" onClick={() => nav.openUrl(webUrl)}>{compact ? "Proxmox" : "Open in Proxmox"}</Button>
        </div>
      </div>
      <Tabs defaultValue="overview">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="backups">Snapshots &amp; backups</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-4 pt-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <UsageBar label={`CPU · ${g.maxcpu} cores`} used={running ? g.cpu : 0} total={1} />
            <UsageBar label={`Memory · ${bytes(g.mem)} of ${bytes(g.maxmem)}`} used={running ? g.mem : 0} total={g.maxmem} />
            <UsageBar label={`Disk · ${g.disk ? `${bytes(g.disk)} of ` : ""}${bytes(g.maxdisk)}`} used={g.disk} total={g.maxdisk} />
          </div>
          <section className="space-y-1.5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Network</h4>
            {detail.interfaces.length ? (
              <ul className="space-y-1 text-sm">
                {detail.interfaces.map((i) => <li key={i.name} className="flex flex-wrap gap-x-3"><span className="w-24 font-mono text-xs">{i.name}</span><span className="font-mono text-xs">{[...i.ipv4, ...i.ipv6.filter((a) => !a.startsWith("fe80"))].join("  ") || "no address"}</span></li>)}
              </ul>
            ) : <p className="text-xs text-muted-foreground">{detail.agent === "unavailable" ? "Guest agent not running: IPs unavailable." : running ? "No interfaces reported." : "Stopped."}</p>}
            {nets.map(([k, v]) => <p key={k} className="truncate font-mono text-xs text-muted-foreground" title={v}>{k}: {v}</p>)}
          </section>
          {summary.length ? (
            <section className="space-y-1.5">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Config</h4>
              <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">{summary.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="truncate font-mono" title={v}>{v}</dd></div>)}</dl>
            </section>
          ) : null}
          {detail.notes.trim() ? (
            <section className="space-y-1.5">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</h4>
              <p className="whitespace-pre-wrap text-sm">{detail.notes.trim()}</p>
            </section>
          ) : null}
        </TabsContent>
        <TabsContent value="metrics" className="pt-3"><MetricsPanel target={target} range={range} onRange={setRange} compact={compact} /></TabsContent>
        <TabsContent value="storage" className="space-y-1 pt-3">
          {disks.length ? disks.map(([k, v]) => <p key={k} className="font-mono text-xs"><span className="text-muted-foreground">{k}</span> {v}</p>) : <p className="text-sm text-muted-foreground">No disks in config.</p>}
        </TabsContent>
        <TabsContent value="backups" className="space-y-4 pt-3">
          <section className="space-y-1.5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Snapshots</h4>
            {detail.snapshots.length ? detail.snapshots.map((s) => <p key={s.name} className="text-sm"><span className="font-mono">{s.name}</span>{s.time ? <span className="text-muted-foreground"> · {new Date(s.time * 1000).toLocaleString()}</span> : null}{s.description ? <span className="text-muted-foreground"> · {s.description}</span> : null}</p>) : <p className="text-sm text-muted-foreground">No snapshots.</p>}
          </section>
          <section className="space-y-1.5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Backups</h4>
            <Extras target={target} tab="backups" />
          </section>
        </TabsContent>
        <TabsContent value="tasks" className="pt-3"><Extras target={target} tab="tasks" /></TabsContent>
        <TabsContent value="activity" className="pt-3"><ActivityList items={q.data.activity} changes={q.data.changes} onOpenTarget={onOpen} compact={compact} showTarget={false} /></TabsContent>
      </Tabs>
    </div>
  );
}
