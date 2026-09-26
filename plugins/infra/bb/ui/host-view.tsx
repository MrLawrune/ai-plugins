// One Proxmox node: resources, storage, guests, metrics, tasks, agent activity.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { MetricRange, StoragePool } from "../schemas.ts";
import { ActivityList } from "./activity-feed.tsx";
import { AskAgentMenu } from "./ask-agent.tsx";
import { Chip, EnvBadge, Meter, StateDot, UsageBar } from "./badges.tsx";
import { MetricsPanel } from "./metrics-panel.tsx";
import { GuestTable } from "./env-view.tsx";
import { age, bytes, pct } from "./format.ts";
import { useInfraQuery } from "./hooks.ts";
import { contentLabels } from "./pve-config.ts";
import { DataTable, Empty, Head, Td, Th } from "./table.tsx";
import { TaskList } from "./tasks.tsx";

function StorageTable({ pools, compact }: { pools: StoragePool[]; compact?: boolean }) {
  if (!pools.length) return <Empty>No storage reported.</Empty>;
  const sorted = [...pools].sort((a, b) => a.storage.localeCompare(b.storage));
  return (
    <DataTable>
      <Head><Th>Storage</Th>{compact ? null : <Th>Content</Th>}<Th>Usage</Th></Head>
      <tbody className="divide-y">
        {sorted.map((s) => {
          const up = s.active && s.total > 0;
          const p = pct(s.used, s.total);
          return (
            <tr key={s.storage} className={cn(!up && "text-muted-foreground")}>
              <Td>
                <span className="inline-flex items-center gap-1.5 font-medium">{s.storage}{s.shared ? <Chip>shared</Chip> : null}</span>
                <span className="block text-xs text-muted-foreground">{s.type}</span>
              </Td>
              {compact ? null : (
                <Td className="whitespace-normal"><span className="flex min-w-32 max-w-64 flex-wrap gap-1">{contentLabels(s.content).map((c) => <Chip key={c}>{c}</Chip>)}</span></Td>
              )}
              <Td>
                {up ? (
                  <span className="block w-36 space-y-1 sm:w-44">
                    <span className="flex justify-between gap-2 text-xs tabular-nums"><span>{bytes(s.used)}<span className="text-muted-foreground"> of {bytes(s.total)}</span></span><span>{p}%</span></span>
                    <Meter percent={p} label={`${s.storage} usage`} />
                  </span>
                ) : <span className="text-xs">unavailable</span>}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}

export function HostView({ target, onOpen, compact }: { target: string; onOpen(target: string): void; compact?: boolean }) {
  const q = useInfraQuery("host", { target });
  const env = useInfraQuery("env", { slug: target.split("/")[0]! });
  const nav = useBbNavigate();
  const [range, setRange] = useState<MetricRange>("hour");
  if (q.error && !q.data) return <p className="text-sm text-destructive">{q.error}</p>;
  if (!q.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!q.data.found) return <p className="text-sm text-muted-foreground">{target} is not in the current inventory.</p>;
  const { detail, webUrl } = q.data;
  const slug = q.data.env.slug;
  const h = detail.host;
  const guests = env.data?.found ? env.data.guests.filter((g) => g.node === h.node) : [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-lg font-semibold"><StateDot state={h.online ? "online" : "offline"} />{h.node}</div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <EnvBadge env={q.data.env} />
            {h.ip ? <span className="font-mono">{h.ip}</span> : null}
            {detail.pveVersion ? <span>PVE {detail.pveVersion}</span> : null}
            {detail.kernel ? <span>kernel {detail.kernel}</span> : null}
            <span>up {age(h.uptime * 1000)}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <AskAgentMenu target={target} kind="host" />
          <Button variant="ghost" size="sm" onClick={() => nav.openUrl(webUrl)}>Open in Proxmox</Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <UsageBar label="CPU" detail={`${h.maxcpu} threads${detail.cpuModel ? ` · ${detail.cpuModel}` : ""}`} used={h.cpu} total={1} />
        <UsageBar label="Memory" detail={`${bytes(h.mem)} of ${bytes(h.maxmem)}`} used={h.mem} total={h.maxmem} />
        <UsageBar label="Root disk" detail={`${bytes(h.disk)} of ${bytes(h.maxdisk)}`} used={h.disk} total={h.maxdisk} />
      </div>
      {detail.loadavg ? <p className="text-xs text-muted-foreground">Load {detail.loadavg.join(" · ")}</p> : null}
      <Tabs defaultValue="guests">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="guests">Guests</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="guests" className="pt-3"><GuestTable guests={guests} onOpen={(t) => onOpen(`${slug}/${t}`)} compact={compact} /></TabsContent>
        <TabsContent value="metrics" className="pt-3"><MetricsPanel target={target} range={range} onRange={setRange} compact={compact} /></TabsContent>
        <TabsContent value="storage" className="pt-3"><StorageTable pools={detail.storage} compact={compact} /></TabsContent>
        <TabsContent value="tasks" className="pt-3"><TaskList tasks={q.data.tasks} /></TabsContent>
        <TabsContent value="activity" className="pt-3"><ActivityList items={q.data.activity} changes={[]} onOpenTarget={onOpen} compact={compact} /></TabsContent>
      </Tabs>
    </div>
  );
}
