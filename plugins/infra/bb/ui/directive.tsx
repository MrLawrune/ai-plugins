// ::infra-guest{env="homelab" id="pve1/201"} and ::infra-host{env="homelab" node="pve1"} live cards in chat.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { EnvBadge, StateDot } from "./badges.tsx";
import { Sparkline } from "./charts.tsx";
import { age, bytes, pct } from "./format.ts";
import { useInfraQuery } from "./hooks.ts";
import { parseDirectiveAttrs } from "./directive-attrs.ts";
import { PANEL_ACTION_ID } from "./thread-panel.tsx";
import { PANEL_PATH } from "./page.tsx";
import { requestPanelReset } from "./panel-reset.ts";

function useOpenTarget() {
  const nav = useBbNavigate();
  return (target: string, title: string) => {
    if (nav.openThreadPanel({ actionId: PANEL_ACTION_ID, title, params: { target } })) requestPanelReset(target);
    else nav.toPluginPanel(PANEL_PATH, { subPath: target });
  };
}

function Literal({ source }: { source: string }) {
  return <code className="text-xs text-muted-foreground">{source}</code>;
}

function Card({ children, onClick, label }: { children: React.ReactNode; onClick(): void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="my-1 flex w-full max-w-md items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left hover:bg-state-hover">
      {children}
    </button>
  );
}

function GuestCard({ target }: { target: string }) {
  const q = useInfraQuery("guestSummary", { target }, { refreshOn: ["infra:changed", "infra:activity"] });
  const m = useInfraQuery("metrics", { target, range: "hour" }, { refreshOn: [], intervalMs: 60_000 });
  const open = useOpenTarget();
  if (!q.data) return <div className="my-1 h-14 max-w-md animate-pulse rounded-lg border bg-muted/40" />;
  if (!q.data.found) return <div className="my-1 max-w-md rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">{target} is not in the current inventory</div>;
  const { guest: g, env, ips, running } = q.data;
  const cpu = m.data?.found ? m.data.series.points.map((p) => p.cpu ?? 0) : [];
  return (
    <Card onClick={() => open(target, g.name)} label={`Open ${g.name} in the Infra panel`}>
      <StateDot state={g.state} active={running} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium"><span className="truncate">{g.name}</span><span className="shrink-0 text-xs font-normal text-muted-foreground">{g.type === "qemu" ? "VM" : "CT"} {g.vmid} · {g.node}</span></div>
        <div className="truncate text-xs text-muted-foreground">
          {g.state}{g.state === "running" ? ` · up ${age(g.uptime * 1000)} · mem ${pct(g.mem, g.maxmem)}% of ${bytes(g.maxmem)}` : ""}{ips[0] ? ` · ${ips[0]}` : ""}
        </div>
      </div>
      <div className="hidden w-20 shrink-0 sm:block"><Sparkline values={cpu} label={`${g.name} CPU, last hour`} /></div>
      <EnvBadge env={env} className="shrink-0" />
    </Card>
  );
}

function HostCardInline({ target }: { target: string }) {
  const q = useInfraQuery("hostSummary", { target }, { refreshOn: ["infra:changed", "infra:activity"] });
  const open = useOpenTarget();
  if (!q.data) return <div className="my-1 h-14 max-w-md animate-pulse rounded-lg border bg-muted/40" />;
  if (!q.data.found) return <div className="my-1 max-w-md rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">{target} is not in the current inventory</div>;
  const { host: h, env, guests, running } = q.data;
  return (
    <Card onClick={() => open(target, h.node)} label={`Open ${h.node} in the Infra panel`}>
      <StateDot state={h.online ? "online" : "offline"} active={running} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{h.node}</div>
        <div className="truncate text-xs text-muted-foreground">
          {h.online ? `cpu ${Math.round(h.cpu * 100)}% · mem ${pct(h.mem, h.maxmem)}% · ${guests.running}/${guests.total} guests running` : "offline"}{h.ip ? ` · ${h.ip}` : ""}
        </div>
      </div>
      <EnvBadge env={env} className="shrink-0" />
    </Card>
  );
}

export function GuestDirective({ attributes, source }: PluginMessageDirectiveProps) {
  const target = parseDirectiveAttrs("guest", attributes);
  return target ? <GuestCard target={target} /> : <Literal source={source} />;
}

export function HostDirective({ attributes, source }: PluginMessageDirectiveProps) {
  const target = parseDirectiveAttrs("host", attributes);
  return target ? <HostCardInline target={target} /> : <Literal source={source} />;
}
