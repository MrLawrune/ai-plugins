// One LXC or VM: overview, metrics, storage/snapshots/backups, tasks, agent activity.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MetricRange } from "../schemas.ts";
import { ActivityList } from "./activity-feed.tsx";
import { AskAgentMenu } from "./ask-agent.tsx";
import { Chip, EnvBadge, StateDot, UsageBar } from "./badges.tsx";
import { age, bytes } from "./format.ts";
import { useInfraQuery, useNow } from "./hooks.ts";
import { MetricsPanel } from "./metrics-panel.tsx";
import { configRows, DISK_KEY, networkRows, parseDisk, type NetworkRow } from "./pve-config.ts";
import { DataTable, Empty, Head, SectionTitle, Td, Th } from "./table.tsx";
import { TaskList } from "./tasks.tsx";

function Extras({ target, tab }: { target: string; tab: "tasks" | "backups" }) {
  const q = useInfraQuery("guestExtras", { target, tab }, { refreshOn: [] });
  const now = useNow();
  if (q.error) return <p className="text-sm text-destructive">{q.error}</p>;
  if (!q.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!q.data.found) return null;
  if (tab === "tasks") return <TaskList tasks={q.data.tasks ?? []} />;
  const backups = q.data.backups ?? [];
  if (!backups.length) return <Empty>No backups found on this host's backup storages.</Empty>;
  return (
    <DataTable>
      <Head><Th>Taken</Th><Th>Archive</Th><Th>Storage</Th><Th className="text-right">Size</Th><Th>Notes</Th></Head>
      <tbody className="divide-y">
        {backups.map((b) => (
          <tr key={b.volid}>
            <Td className="tabular-nums" title={new Date(b.ctime * 1000).toLocaleString()}>{age(now - b.ctime * 1000)} ago</Td>
            <Td className="max-w-[18rem] truncate font-mono text-xs" title={b.volid}>{b.volid.split("/").pop()}</Td>
            <Td className="text-muted-foreground">{b.storage}</Td>
            <Td className="text-right tabular-nums">{bytes(b.size)}</Td>
            <Td className="max-w-[16rem] truncate text-muted-foreground" title={b.notes ?? undefined}>{b.notes ?? ""}</Td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function Addresses({ row, agent, running }: { row: NetworkRow; agent: "ok" | "unavailable" | "n/a"; running: boolean }) {
  if (row.ipv4.length || row.ipv6.length) {
    return (
      <span className="flex flex-col font-mono text-xs">
        {row.ipv4.map((a) => <span key={a}>{a}</span>)}
        {row.ipv6.map((a) => <span key={a} className="text-muted-foreground">{a}</span>)}
      </span>
    );
  }
  const why = !running ? "stopped" : agent === "unavailable" ? "no guest agent" : "none reported";
  return (
    <span className="flex flex-col text-xs text-muted-foreground">
      {row.configured ? <span className="font-mono">{row.configured}</span> : null}
      <span className="italic">{why}</span>
    </span>
  );
}

function NetworkTable({ rows, agent, running, compact }: { rows: NetworkRow[]; agent: "ok" | "unavailable" | "n/a"; running: boolean; compact?: boolean }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">No network interfaces.</p>;
  const link = (r: NetworkRow) => r.bridge ? (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span>{r.bridge}</span>
      {r.vlan ? <Chip>VLAN {r.vlan}</Chip> : null}
      {r.firewall ? <Chip>firewall</Chip> : null}
    </span>
  ) : <span className="text-muted-foreground">inside guest</span>;
  return (
    <DataTable>
      <Head><Th>Interface</Th><Th>Addresses</Th>{compact ? null : <Th>Bridge</Th>}{compact ? null : <Th>MAC</Th>}</Head>
      <tbody className="divide-y">
        {rows.map((r) => (
          <tr key={`${r.name}-${r.mac ?? ""}`}>
            <Td>
              <span className="font-mono text-xs font-medium">{r.name}</span>
              {compact ? <span className="block text-xs text-muted-foreground">{link(r)}</span> : null}
            </Td>
            <Td><Addresses row={r} agent={agent} running={running} /></Td>
            {compact ? null : <Td className="text-xs">{link(r)}</Td>}
            {compact ? null : <Td className="font-mono text-xs text-muted-foreground">{r.mac ?? "—"}</Td>}
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function DiskTable({ config, compact }: { config: Record<string, string>; compact?: boolean }) {
  const disks = Object.entries(config).filter(([k]) => DISK_KEY.test(k)).sort(([a], [b]) => (a === "rootfs" ? -1 : b === "rootfs" ? 1 : a.localeCompare(b, undefined, { numeric: true }))).map(([k, v]) => parseDisk(k, v));
  if (!disks.length) return <Empty>No disks in config.</Empty>;
  const showOptions = !compact && disks.some((d) => d.options.length);
  return (
    <DataTable>
      <Head><Th>Disk</Th><Th>Storage</Th>{compact ? null : <Th>Volume</Th>}<Th className="text-right">Size</Th><Th>Mount</Th>{showOptions ? <Th>Options</Th> : null}</Head>
      <tbody className="divide-y">
        {disks.map((d) => (
          <tr key={d.key}>
            <Td className="font-mono text-xs font-medium">{d.key}</Td>
            <Td title={d.volume || undefined}>{d.storage}{d.media ? <Chip className="ml-1.5">{d.media}</Chip> : null}</Td>
            {compact ? null : <Td className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground" title={d.volume}>{d.volume || "—"}</Td>}
            <Td className="text-right tabular-nums">{d.size ?? "—"}</Td>
            <Td className="font-mono text-xs">{d.mount ?? <span className="text-muted-foreground">—</span>}</Td>
            {showOptions ? <Td><span className="flex flex-wrap gap-1">{d.options.map((o) => <Chip key={o} mono>{o}</Chip>)}</span></Td> : null}
          </tr>
        ))}
      </tbody>
    </DataTable>
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
  const summary = configRows(detail.config, bytes);
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
            <UsageBar label="CPU" detail={`${g.maxcpu} cores`} used={running ? g.cpu : 0} total={1} />
            <UsageBar label="Memory" detail={`${running ? `${bytes(g.mem)} of ` : ""}${bytes(g.maxmem)}`} used={running ? g.mem : 0} total={g.maxmem} />
            <UsageBar label="Disk" detail={`${g.disk ? `${bytes(g.disk)} of ` : ""}${bytes(g.maxdisk)}`} used={g.disk} total={g.maxdisk} />
          </div>
          <section className="space-y-1.5">
            <SectionTitle>Network</SectionTitle>
            <NetworkTable rows={networkRows(detail.config, detail.interfaces)} agent={detail.agent} running={running} compact={compact} />
          </section>
          {summary.length ? (
            <section className="space-y-1.5">
              <SectionTitle>Config</SectionTitle>
              <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-xs">
                {summary.map((r) => (
                  <div key={r.key} className="contents">
                    <dt className="text-muted-foreground">{r.label}</dt>
                    <dd className="min-w-0" title={r.value}>{r.chips ? <span className="flex flex-wrap gap-1">{r.chips.map((c) => <Chip key={c} mono>{c}</Chip>)}</span> : <span className="truncate">{r.value}</span>}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {detail.notes.trim() ? (
            <section className="space-y-1.5">
              <SectionTitle>Notes</SectionTitle>
              <p className="whitespace-pre-wrap text-sm">{detail.notes.trim()}</p>
            </section>
          ) : null}
        </TabsContent>
        <TabsContent value="metrics" className="pt-3"><MetricsPanel target={target} range={range} onRange={setRange} compact={compact} /></TabsContent>
        <TabsContent value="storage" className="pt-3"><DiskTable config={detail.config} compact={compact} /></TabsContent>
        <TabsContent value="backups" className="space-y-4 pt-3">
          <section className="space-y-1.5">
            <SectionTitle>Snapshots</SectionTitle>
            {detail.snapshots.length ? (
              <DataTable>
                <Head><Th>Name</Th><Th>Taken</Th><Th>Description</Th></Head>
                <tbody className="divide-y">
                  {detail.snapshots.map((sn) => (
                    <tr key={sn.name}>
                      <Td className="font-mono text-xs font-medium">{sn.name}</Td>
                      <Td className="tabular-nums text-muted-foreground">{sn.time ? new Date(sn.time * 1000).toLocaleString() : "—"}</Td>
                      <Td className="max-w-[20rem] truncate text-muted-foreground" title={sn.description}>{sn.description}</Td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            ) : <p className="text-sm text-muted-foreground">No snapshots.</p>}
          </section>
          <section className="space-y-1.5">
            <SectionTitle>Backups</SectionTitle>
            <Extras target={target} tab="backups" />
          </section>
        </TabsContent>
        <TabsContent value="tasks" className="pt-3"><Extras target={target} tab="tasks" /></TabsContent>
        <TabsContent value="activity" className="pt-3"><ActivityList items={q.data.activity} changes={q.data.changes} onOpenTarget={onOpen} compact={compact} showTarget={false} /></TabsContent>
      </Tabs>
    </div>
  );
}
