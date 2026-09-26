// Parses Proxmox guest config property strings ("local-lvm:vm-1-disk-0,size=8G") into display rows.
import type { NetIf } from "../server/providers/types.ts";

export const DISK_KEY = /^(rootfs|mp\d+|scsi\d+|virtio\d+|sata\d+|ide\d+|efidisk\d+|tpmstate\d+|unused\d+)$/;
export const NET_KEY = /^net\d+$/;
const NIC_MODELS = new Set(["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3", "ne2k_pci", "pcnet", "i82551", "i82557b", "i82559er"]);

export interface PropString { head: string | null; props: Record<string, string> }

/** Splits "head,k=v,k2=v2". The head is the first segment when it has no "=". */
export function parseProps(value: string): PropString {
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  const props: Record<string, string> = {};
  let head: string | null = null;
  parts.forEach((p, i) => {
    const eq = p.indexOf("=");
    if (eq < 0) { if (i === 0) head = p; else props[p] = "1"; return; }
    props[p.slice(0, eq)] = p.slice(eq + 1);
  });
  return { head, props };
}

export interface DiskRow { key: string; storage: string; volume: string; size: string | null; mount: string | null; media: string | null; options: string[] }

const DISK_CONSUMED = new Set(["size", "mp", "media", "file", "volume"]);

export function parseDisk(key: string, value: string): DiskRow {
  const { head, props } = parseProps(value);
  const src = head ?? props.file ?? props.volume ?? "";
  const colon = src.indexOf(":");
  const isPath = src.startsWith("/");
  const storage = isPath ? "bind mount" : colon > 0 ? src.slice(0, colon) : src || "—";
  const volume = isPath ? src : colon > 0 ? src.slice(colon + 1) : "";
  const options = Object.entries(props).filter(([k]) => !DISK_CONSUMED.has(k)).map(([k, v]) => optionLabel(k, v));
  return { key, storage, volume, size: props.size ? sizeLabel(props.size) : null, mount: props.mp ?? (key === "rootfs" ? "/" : null), media: props.media ?? null, options };
}

export interface NetRow { key: string; name: string; model: string | null; mac: string | null; bridge: string | null; vlan: string | null; firewall: boolean; ipv4: string | null; ipv6: string | null; gateway: string | null; options: string[] }

const NET_CONSUMED = new Set(["name", "hwaddr", "bridge", "tag", "firewall", "ip", "ip6", "gw", "gw6", "type", "macaddr"]);

export function parseNet(key: string, value: string): NetRow {
  const { props } = parseProps(value);
  const model = Object.keys(props).find((k) => NIC_MODELS.has(k)) ?? null;
  const mac = props.hwaddr ?? props.macaddr ?? (model ? props[model] : undefined) ?? null;
  const options = Object.entries(props).filter(([k]) => !NET_CONSUMED.has(k) && k !== model).map(([k, v]) => optionLabel(k, v));
  return {
    key,
    name: props.name ?? key,
    model,
    mac: mac ? mac.toUpperCase() : null,
    bridge: props.bridge ?? null,
    vlan: props.tag ?? null,
    firewall: props.firewall === "1",
    ipv4: props.ip ?? null,
    ipv6: props.ip6 ?? null,
    gateway: props.gw ?? null,
    options,
  };
}

const UNITS: Record<string, string> = { K: "KiB", M: "MiB", G: "GiB", T: "TiB" };

/** Proxmox disk sizes ("16G", "512M") in the same units the rest of the UI uses. */
export function sizeLabel(size: string): string {
  const m = /^(\d+(?:\.\d+)?)([KMGT])?$/i.exec(size.trim());
  if (!m) return size;
  return m[2] ? `${m[1]} ${UNITS[m[2].toUpperCase()]}` : `${m[1]} B`;
}

function optionLabel(k: string, v: string): string {
  if (v === "1" || v === "on") return k;
  if (v === "0" || v === "off") return `no ${k}`;
  return `${k}=${v}`;
}

export interface NetworkRow { name: string; ipv4: string[]; ipv6: string[]; mac: string | null; bridge: string | null; vlan: string | null; firewall: boolean; configured: string | null; live: boolean }

/** Joins config NICs with the addresses the guest reports. Runtime-only interfaces (VPNs, bridges inside the guest) follow. */
export function networkRows(config: Record<string, string>, interfaces: NetIf[]): NetworkRow[] {
  const nets = Object.entries(config).filter(([k]) => NET_KEY.test(k)).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([k, v]) => parseNet(k, v));
  const used = new Set<NetIf>();
  const rows: NetworkRow[] = nets.map((n) => {
    const live = interfaces.find((i) => !used.has(i) && ((n.mac && i.mac?.toUpperCase() === n.mac) || i.name === n.name));
    if (live) used.add(live);
    const configured = [n.ipv4, n.ipv6].filter((x): x is string => !!x).join(" · ") || null;
    return {
      name: live?.name ?? n.name,
      ipv4: live?.ipv4 ?? [],
      ipv6: (live?.ipv6 ?? []).filter(isRoutableV6),
      mac: n.mac,
      bridge: n.bridge,
      vlan: n.vlan,
      firewall: n.firewall,
      configured,
      live: !!live,
    };
  });
  for (const i of interfaces) {
    if (used.has(i)) continue;
    rows.push({ name: i.name, ipv4: i.ipv4, ipv6: i.ipv6.filter(isRoutableV6), mac: i.mac?.toUpperCase() ?? null, bridge: null, vlan: null, firewall: false, configured: null, live: true });
  }
  return rows;
}

function isRoutableV6(a: string): boolean {
  return !a.toLowerCase().startsWith("fe80");
}

export interface ConfigRow { key: string; label: string; value: string; chips?: string[] }

const MIB = 1024 * 1024;
const CONFIG_LABELS: Record<string, string> = {
  cores: "Cores", sockets: "Sockets", cpu: "CPU type", memory: "Memory", swap: "Swap", balloon: "Balloon", ostype: "OS type", onboot: "Start at boot",
  unprivileged: "Unprivileged", features: "Features", bios: "BIOS", machine: "Machine", agent: "Guest agent", nameserver: "DNS servers", searchdomain: "Search domain",
  startup: "Startup order", protection: "Protection", arch: "Arch",
};
export const CONFIG_KEYS = Object.keys(CONFIG_LABELS);

/** Readable config summary: MiB to sizes, 0/1 to yes/no, feature lists to chips. */
export function configRows(config: Record<string, string>, bytes: (n: number) => string): ConfigRow[] {
  const rows: ConfigRow[] = [];
  for (const key of CONFIG_KEYS) {
    const raw = config[key];
    if (raw === undefined) continue;
    const label = CONFIG_LABELS[key]!;
    if ((key === "memory" || key === "swap" || key === "balloon") && /^\d+$/.test(raw)) rows.push({ key, label, value: bytes(Number(raw) * MIB) });
    else if (raw === "0" || raw === "1") rows.push({ key, label, value: raw === "1" ? "yes" : "no" });
    else if (key === "features" || key === "agent" || key === "startup") {
      const { head, props } = parseProps(raw);
      const chips = [...(head ? [head === "1" ? "enabled" : head] : []), ...Object.entries(props).filter(([, v]) => v !== "0").map(([k, v]) => optionLabel(k, v))];
      rows.push({ key, label, value: raw, chips });
    } else if (key === "nameserver") rows.push({ key, label, value: raw, chips: raw.split(/\s+/).filter(Boolean) });
    else rows.push({ key, label, value: raw });
  }
  return rows;
}

const CONTENT_LABELS: Record<string, string> = {
  images: "VM disks", rootdir: "CT volumes", vztmpl: "CT templates", iso: "ISO images", backup: "Backups", snippets: "Snippets", import: "Import",
};

const CONTENT_ORDER = Object.keys(CONTENT_LABELS);

/** Storage content types as friendly labels, in a stable order. */
export function contentLabels(content: string[]): string[] {
  const rank = (c: string) => { const i = CONTENT_ORDER.indexOf(c); return i < 0 ? CONTENT_ORDER.length : i; };
  return [...content].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((c) => CONTENT_LABELS[c] ?? c);
}
