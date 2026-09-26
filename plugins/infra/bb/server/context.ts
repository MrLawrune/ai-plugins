// Token-frugal plain-text context for agents, plus the markdown registry export.
import { age, bytes, pct } from "../shared/format.ts";
import type { EnvSnapshot } from "./hub.ts";
import type { GuestDetail, HealthCode } from "./providers/types.ts";
import type { ActivityRow } from "./store.ts";

type Ips = ReadonlyMap<string, string[]>;
const CMD_PREVIEW = 80;

export function envHealth(s: EnvSnapshot): HealthCode {
  const bad = s.connections.find((c) => c.health.code !== "ok" && c.health.code !== "disabled");
  return bad ? bad.health.code : "ok";
}

export function envIndexLine(s: EnvSnapshot): string {
  const hostsUp = s.hosts.filter((h) => h.online).length;
  const guests = s.guests.filter((g) => !g.template);
  const running = guests.filter((g) => g.state === "running").length;
  return `${s.env.slug} (${s.env.kind}) · ${hostsUp}/${s.hosts.length} hosts · ${running}/${guests.length} running · ${envHealth(s)}`;
}

export function applyBudget(lines: string[], budget: number, envSlug: string): string {
  if (lines.length <= budget) return lines.join("\n");
  const keep = Math.max(1, budget - 1);
  return [...lines.slice(0, keep), `… ${lines.length - keep} more lines (bb infra registry ${envSlug})`].join("\n");
}

const findHost = (s: EnvSnapshot, node: string) => s.hosts.find((h) => h.node.toLowerCase() === node.toLowerCase()) ?? null;
const guestIpsOf = (s: EnvSnapshot, node: string, vmid: number, ips: Ips) => ips.get(`${s.env.slug}/${node}/${vmid}`) ?? [];

function activityLines(rows: ActivityRow[], now: number): string[] {
  if (!rows.length) return [];
  return ["recent agent activity:", ...rows.slice(0, 3).map((a) => `  ${age(now - a.at)} ago ${a.threadId} $ ${a.command.slice(0, CMD_PREVIEW)}`)];
}

export function guestCard(s: EnvSnapshot, node: string, vmid: number, detail: GuestDetail | null, activity: ActivityRow[], o: { budget: number; ips: Ips; now: number }): string | null {
  const g = s.guests.find((x) => x.vmid === vmid && x.node.toLowerCase() === node.toLowerCase());
  if (!g) return null;
  const ipList = detail ? detail.interfaces.flatMap((i) => i.ipv4) : guestIpsOf(s, g.node, g.vmid, o.ips);
  const lines = [
    `${s.env.slug}/${g.node}/${g.vmid} ${g.name} · ${g.type} · ${g.state}${g.state === "running" ? ` · up ${age(g.uptime * 1000)}` : ""}${g.template ? " · template" : ""}`,
    `cpu ${g.maxcpu} cores · mem ${bytes(g.mem)}/${bytes(g.maxmem)} · disk ${bytes(g.disk)}/${bytes(g.maxdisk)}`,
    `ips ${ipList.length ? ipList.join(", ") : "-"}`,
  ];
  if (g.tags.length) lines.push(`tags ${g.tags.join(", ")}`);
  if (detail) {
    const facts = [detail.os && `os ${detail.os}`, detail.hostname && `hostname ${detail.hostname}`].filter(Boolean);
    if (facts.length) lines.push(facts.join(" · "));
    if (detail.snapshots.length) lines.push(`snapshots ${detail.snapshots.map((x) => x.name).join(", ")}`);
    const notes = detail.notes.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3);
    if (notes.length) lines.push(`notes: ${notes.join(" | ")}`);
  }
  lines.push(...activityLines(activity, o.now));
  return applyBudget(lines, o.budget, s.env.slug);
}

export function hostCard(s: EnvSnapshot, node: string, activity: ActivityRow[], o: { budget: number; now: number }): string | null {
  const h = findHost(s, node);
  if (!h) return null;
  const guests = s.guests.filter((g) => g.node === h.node && !g.template);
  const lines = [
    `${s.env.slug}/${h.node} · ${h.online ? "online" : "offline"}${h.online ? ` · up ${age(h.uptime * 1000)}` : ""}${h.ip ? ` · ${h.ip}` : ""}`,
    `cpu ${Math.round(h.cpu * 100)}% of ${h.maxcpu} · mem ${pct(h.mem, h.maxmem)}% of ${bytes(h.maxmem)} · disk ${pct(h.disk, h.maxdisk)}% of ${bytes(h.maxdisk)}`,
    `guests ${guests.filter((g) => g.state === "running").length} running / ${guests.length}`,
  ];
  const pools = s.storage.filter((p) => p.node === h.node && p.active && p.total > 0);
  if (pools.length) lines.push(`storage ${pools.map((p) => `${p.storage} ${pct(p.used, p.total)}%`).join(", ")}`);
  lines.push(...activityLines(activity, o.now));
  return applyBudget(lines, o.budget, s.env.slug);
}

function hostLine(h: EnvSnapshot["hosts"][number]): string {
  if (!h.online) return `  ${h.node} ${h.ip ?? "-"} offline`;
  return `  ${h.node} ${h.ip ?? "-"} cpu ${Math.round(h.cpu * 100)}% mem ${pct(h.mem, h.maxmem)}% disk ${pct(h.disk, h.maxdisk)}% up ${age(h.uptime * 1000)}`;
}

export function envCard(s: EnvSnapshot, o: { rules: boolean; budget: number; ips: Ips }): string {
  const lines = [envIndexLine(s), "Hosts:", ...s.hosts.map(hostLine), "Guests:"];
  for (const g of s.guests.filter((x) => !x.template)) {
    const ips = guestIpsOf(s, g.node, g.vmid, o.ips);
    lines.push(`  ${g.vmid} ${g.name} ${g.type} ${g.state} ${ips.length ? ips.join(",") : "-"}`);
  }
  if (o.rules && s.env.rules.trim()) lines.push("Rules:", ...s.env.rules.trim().split(/\r?\n/));
  return applyBudget(lines, o.budget, s.env.slug);
}

const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function registryMarkdown(s: EnvSnapshot, ips: Ips): string {
  const out = [
    `# ${s.env.name} (${s.env.kind})`,
    "",
    `Generated by the BB Infra plugin from live Proxmox data. Read-only reference: \`${envIndexLine(s)}\`.`,
    "",
    "## Hosts",
    "",
    "| Node | IP | State | CPU | Memory | Disk | Uptime |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...s.hosts.map((h) => `| ${cell(h.node)} | ${h.ip ?? "-"} | ${h.online ? "online" : "offline"} | ${Math.round(h.cpu * 100)}% of ${h.maxcpu} | ${bytes(h.mem)}/${bytes(h.maxmem)} | ${bytes(h.disk)}/${bytes(h.maxdisk)} | ${h.online ? age(h.uptime * 1000) : "-"} |`),
    "",
    "## Guests",
    "",
    "| VMID | Name | Type | Node | State | IPs | Tags |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...s.guests.map((g) => `| ${g.vmid} | ${cell(g.name)} | ${g.type}${g.template ? " (template)" : ""} | ${cell(g.node)} | ${g.state} | ${guestIpsOf(s, g.node, g.vmid, ips).join(", ") || "-"} | ${cell(g.tags.join(", ")) || "-"} |`),
  ];
  return out.join("\n") + "\n";
}
