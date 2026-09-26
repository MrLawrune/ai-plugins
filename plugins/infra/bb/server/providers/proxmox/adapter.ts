// Proxmox VE → provider-neutral model. Read-only: every call is a GET.
import type {
  BackupEntry, GuestDetail, GuestRef, GuestState, HostDetail, HostState, InfraProvider, Inventory,
  MetricRange, MetricSeries, NetIf, RunState, Snapshot, StoragePool, TargetRef, TaskEntry,
} from "../types.ts";

export interface GetClient {
  get<T>(path: string, query?: Record<string, string | number>, signal?: AbortSignal): Promise<T>;
}

type Raw = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const RUN_STATES: ReadonlySet<string> = new Set(["running", "stopped", "paused"]);
const runState = (v: unknown): RunState => (RUN_STATES.has(str(v)) ? (str(v) as RunState) : "unknown");
const splitTags = (v: unknown): string[] => str(v).split(/[;,\s]+/).filter(Boolean);
const isLoopback = (name: string) => name === "lo";

function mapGuest(r: Raw, node: string, type: "lxc" | "qemu"): GuestState {
  return {
    node,
    vmid: num(r.vmid),
    type,
    name: str(r.name),
    state: runState(r.status),
    cpu: num(r.cpu),
    maxcpu: num(r.maxcpu ?? r.cpus),
    mem: num(r.mem),
    maxmem: num(r.maxmem),
    disk: num(r.disk),
    maxdisk: num(r.maxdisk),
    uptime: num(r.uptime),
    tags: splitTags(r.tags),
    template: num(r.template) === 1,
  };
}

function mapStorage(r: Raw, node: string): StoragePool {
  return {
    node,
    storage: str(r.storage),
    type: str(r.plugintype ?? r.type),
    content: str(r.content).split(",").filter(Boolean),
    used: num(r.disk ?? r.used),
    total: num(r.maxdisk ?? r.total),
    shared: num(r.shared) === 1,
    active: r.status !== undefined ? r.status === "available" : num(r.active) === 1,
  };
}

export function mapResources(raw: unknown[]): Inventory {
  const inv: Inventory = { hosts: [], guests: [], storage: [] };
  for (const item of raw) {
    const r = item as Raw;
    const node = str(r.node);
    if (r.type === "node") {
      inv.hosts.push({
        node, online: r.status === "online", cpu: num(r.cpu), maxcpu: num(r.maxcpu), mem: num(r.mem), maxmem: num(r.maxmem),
        disk: num(r.disk), maxdisk: num(r.maxdisk), uptime: num(r.uptime), ip: null,
      });
    } else if (r.type === "lxc" || r.type === "qemu") {
      inv.guests.push(mapGuest(r, node, r.type));
    } else if (r.type === "storage") {
      inv.storage.push(mapStorage(r, node));
    }
  }
  return inv;
}

export function isCluster(status: unknown[]): boolean {
  return status.some((e) => (e as Raw).type === "cluster");
}

function mapLxcInterfaces(raw: unknown): NetIf[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((i: Raw) => {
    const addrs = Array.isArray(i["ip-addresses"]) ? (i["ip-addresses"] as Raw[]) : [];
    return {
      name: str(i.name),
      mac: str(i.hwaddr ?? i["hardware-address"]) || null,
      ipv4: addrs.filter((a) => a["ip-address-type"] === "inet").map((a) => str(a["ip-address"])),
      ipv6: addrs.filter((a) => a["ip-address-type"] === "inet6").map((a) => str(a["ip-address"])),
    };
  }).filter((i) => !isLoopback(i.name));
}

function mapAgentInterfaces(raw: unknown): NetIf[] {
  const list = (raw as { result?: unknown })?.result;
  if (!Array.isArray(list)) return [];
  return list.map((i: Raw) => {
    const addrs = Array.isArray(i["ip-addresses"]) ? (i["ip-addresses"] as Raw[]) : [];
    return {
      name: str(i.name),
      mac: str(i["hardware-address"]) || null,
      ipv4: addrs.filter((a) => a["ip-address-type"] === "ipv4").map((a) => str(a["ip-address"])),
      ipv6: addrs.filter((a) => a["ip-address-type"] === "ipv6").map((a) => str(a["ip-address"])),
    };
  }).filter((i) => !isLoopback(i.name));
}

const CONFIG_NOISE = new Set(["description", "digest", "lxc"]);

function decodeNotes(v: unknown): string {
  const s = str(v);
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function mapRrd(raw: unknown, range: MetricRange): MetricSeries {
  const rows = Array.isArray(raw) ? (raw as Raw[]) : [];
  return {
    range,
    points: rows.map((r) => ({
      t: num(r.time) * 1000,
      cpu: numOrNull(r.cpu),
      mem: numOrNull(r.mem ?? r.memused),
      maxmem: numOrNull(r.maxmem ?? r.memtotal),
      netin: numOrNull(r.netin),
      netout: numOrNull(r.netout),
      diskread: numOrNull(r.diskread),
      diskwrite: numOrNull(r.diskwrite),
    })),
  };
}

function mapTask(r: Raw): TaskEntry {
  return {
    upid: str(r.upid), node: str(r.node), type: str(r.type), id: str(r.id), user: str(r.user),
    status: r.status === undefined ? null : str(r.status), start: num(r.starttime), end: r.endtime === undefined ? null : num(r.endtime),
  };
}

const guestPath = (ref: GuestRef) => `/nodes/${encodeURIComponent(ref.node)}/${ref.type}/${ref.vmid}`;
const hostPath = (node: string) => `/nodes/${encodeURIComponent(node)}`;

export class ProxmoxProvider implements InfraProvider {
  readonly kind = "proxmox" as const;
  private readonly client: GetClient;
  private readonly baseUrl: string;

  constructor(client: GetClient, baseUrl: string) {
    this.client = client;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async inventory(signal: AbortSignal): Promise<Inventory> {
    const [resources, status] = await Promise.all([
      this.client.get<unknown[]>("/cluster/resources", undefined, signal),
      this.client.get<unknown[]>("/cluster/status", undefined, signal),
    ]);
    const inv = mapResources(resources);
    const ips = new Map<string, string>();
    for (const e of status as Raw[]) if (e.type === "node" && typeof e.ip === "string") ips.set(str(e.name), e.ip);
    for (const h of inv.hosts) h.ip = ips.get(h.node) ?? null;
    return inv;
  }

  async hostDetail(node: string, signal: AbortSignal): Promise<HostDetail> {
    const [s, storage] = await Promise.all([
      this.client.get<Raw>(`${hostPath(node)}/status`, undefined, signal),
      this.client.get<Raw[]>(`${hostPath(node)}/storage`, undefined, signal),
    ]);
    const memory = (s.memory ?? {}) as Raw;
    const rootfs = (s.rootfs ?? {}) as Raw;
    const cpuinfo = (s.cpuinfo ?? {}) as Raw;
    const load = Array.isArray(s.loadavg) ? s.loadavg.map(num) : null;
    const host: HostState = {
      node, online: true, cpu: num(s.cpu), maxcpu: num(cpuinfo.cpus), mem: num(memory.used), maxmem: num(memory.total),
      disk: num(rootfs.used), maxdisk: num(rootfs.total), uptime: num(s.uptime), ip: null,
    };
    return {
      host,
      pveVersion: str(s.pveversion).split("/")[1] ?? null,
      kernel: str(s.kversion).match(/Linux (\S+)/)?.[1] ?? null,
      cpuModel: str(cpuinfo.model) || null,
      loadavg: load && load.length === 3 ? [load[0]!, load[1]!, load[2]!] : null,
      storage: storage.map((r) => mapStorage(r, node)),
    };
  }

  async guestDetail(ref: GuestRef, signal: AbortSignal): Promise<GuestDetail> {
    const base = guestPath(ref);
    const [status, config, snaps] = await Promise.all([
      this.client.get<Raw>(`${base}/status/current`, undefined, signal),
      this.client.get<Raw>(`${base}/config`, undefined, signal),
      this.client.get<Raw[]>(`${base}/snapshot`, undefined, signal).catch(() => [] as Raw[]),
    ]);
    let interfaces: NetIf[] = [];
    let agent: GuestDetail["agent"] = "n/a";
    if (ref.type === "lxc") {
      interfaces = mapLxcInterfaces(await this.client.get<unknown>(`${base}/interfaces`, undefined, signal).catch(() => []));
    } else {
      try {
        interfaces = mapAgentInterfaces(await this.client.get<unknown>(`${base}/agent/network-get-interfaces`, undefined, signal));
        agent = "ok";
      } catch {
        agent = "unavailable";
      }
    }
    const guest = mapGuest({ ...status, tags: config.tags ?? status.tags, template: config.template ?? status.template }, ref.node, ref.type);
    const cfg: Record<string, string> = {};
    for (const [k, v] of Object.entries(config)) if (!CONFIG_NOISE.has(k) && (typeof v === "string" || typeof v === "number")) cfg[k] = String(v);
    const snapshots: Snapshot[] = snaps
      .filter((s) => s.name !== "current")
      .map((s) => ({ name: str(s.name), description: str(s.description), time: numOrNull(s.snaptime), parent: str(s.parent) || null }));
    return {
      guest,
      hostname: str(config.hostname) || guest.name || null,
      os: str(config.ostype) || null,
      interfaces,
      config: cfg,
      notes: decodeNotes(config.description),
      snapshots,
      agent,
    };
  }

  async metrics(target: TargetRef, range: MetricRange, signal: AbortSignal): Promise<MetricSeries> {
    const path = target.kind === "host" ? `${hostPath(target.node)}/rrddata` : `${guestPath(target)}/rrddata`;
    return mapRrd(await this.client.get<unknown>(path, { timeframe: range, cf: "AVERAGE" }, signal), range);
  }

  async tasks(target: TargetRef, limit: number, signal: AbortSignal): Promise<TaskEntry[]> {
    const query: Record<string, number> = target.kind === "guest" ? { limit, vmid: target.vmid } : { limit };
    const rows = await this.client.get<Raw[]>(`${hostPath(target.node)}/tasks`, query, signal);
    return rows.map(mapTask);
  }

  async backups(ref: GuestRef, signal: AbortSignal): Promise<BackupEntry[]> {
    const storages = await this.client.get<Raw[]>(`${hostPath(ref.node)}/storage`, undefined, signal);
    const withBackups = storages.filter((s) => str(s.content).split(",").includes("backup") && num(s.active) === 1);
    const lists = await Promise.all(withBackups.map(async (s) => {
      try {
        const rows = await this.client.get<Raw[]>(`${hostPath(ref.node)}/storage/${encodeURIComponent(str(s.storage))}/content`, { content: "backup", vmid: ref.vmid }, signal);
        return rows.map((r) => ({ volid: str(r.volid), storage: str(s.storage), size: num(r.size), ctime: num(r.ctime), notes: str(r.notes) || null }));
      } catch {
        return [];
      }
    }));
    return lists.flat().sort((a, b) => b.ctime - a.ctime);
  }

  async version(signal: AbortSignal): Promise<string | null> {
    return str((await this.client.get<Raw>("/version", undefined, signal)).version) || null;
  }

  webUrl(target: TargetRef | null): string {
    if (!target) return `${this.baseUrl}/`;
    const id = target.kind === "host" ? `node%2F${encodeURIComponent(target.node)}` : `${target.type}%2F${target.vmid}`;
    return `${this.baseUrl}/#v1:0:=${id}:4:::::::`;
  }
}
