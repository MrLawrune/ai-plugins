// One Proxmox node: resources, storage, guests, metrics, tasks, agent activity.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MetricRange } from "../schemas.ts";
import { ActivityList } from "./activity-feed.tsx";
import { AskAgentMenu } from "./ask-agent.tsx";
import { EnvBadge, StateDot, UsageBar } from "./badges.tsx";
import { MetricsPanel } from "./metrics-panel.tsx";
import { GuestTable } from "./env-view.tsx";
import { age, bytes } from "./format.ts";
import { useInfraQuery } from "./hooks.ts";
import { TaskList } from "./tasks.tsx";

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
        <UsageBar label={`CPU · ${h.maxcpu} threads${detail.cpuModel ? ` · ${detail.cpuModel}` : ""}`} used={h.cpu} total={1} />
        <UsageBar label={`Memory · ${bytes(h.mem)} of ${bytes(h.maxmem)}`} used={h.mem} total={h.maxmem} />
        <UsageBar label={`Root disk · ${bytes(h.disk)} of ${bytes(h.maxdisk)}`} used={h.disk} total={h.maxdisk} />
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
        <TabsContent value="storage" className="space-y-3 pt-3">
          {detail.storage.filter((s) => s.total > 0).map((s) => (
            <div key={s.storage} className="space-y-1">
              <UsageBar label={`${s.storage} · ${s.type}${s.shared ? " · shared" : ""} · ${bytes(s.used)} of ${bytes(s.total)}`} used={s.used} total={s.total} />
              <p className="text-xs text-muted-foreground">{s.content.join(", ")}</p>
            </div>
          ))}
        </TabsContent>
        <TabsContent value="tasks" className="pt-3"><TaskList tasks={q.data.tasks} /></TabsContent>
        <TabsContent value="activity" className="pt-3"><ActivityList items={q.data.activity} changes={[]} onOpenTarget={onOpen} compact={compact} /></TabsContent>
      </Tabs>
    </div>
  );
}
