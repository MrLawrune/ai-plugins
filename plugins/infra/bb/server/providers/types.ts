// Provider-neutral infrastructure model. Proxmox is the first InfraProvider.
export type GuestType = "lxc" | "qemu";
export type RunState = "running" | "stopped" | "paused" | "unknown";
export type HealthCode = "ok" | "auth-failed" | "unreachable" | "tls-mismatch" | "degraded" | "disabled";

export interface ConnectionHealth { code: HealthCode; message: string | null; lastOkAt: number | null; staleSince: number | null }
export interface HostState { node: string; online: boolean; cpu: number; maxcpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; ip: string | null }
export interface GuestState { node: string; vmid: number; type: GuestType; name: string; state: RunState; cpu: number; maxcpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; tags: string[]; template: boolean }
export interface StoragePool { node: string; storage: string; type: string; content: string[]; used: number; total: number; shared: boolean; active: boolean }
export interface Inventory { hosts: HostState[]; guests: GuestState[]; storage: StoragePool[] }
export interface NetIf { name: string; mac: string | null; ipv4: string[]; ipv6: string[] }
export interface Snapshot { name: string; description: string; time: number | null; parent: string | null }
export interface GuestDetail { guest: GuestState; hostname: string | null; os: string | null; interfaces: NetIf[]; config: Record<string, string>; notes: string; snapshots: Snapshot[]; agent: "ok" | "unavailable" | "n/a" }
export interface HostDetail { host: HostState; pveVersion: string | null; kernel: string | null; cpuModel: string | null; loadavg: [number, number, number] | null; storage: StoragePool[] }
export type MetricRange = "hour" | "day" | "week";
export interface MetricPoint { t: number; cpu: number | null; mem: number | null; maxmem: number | null; netin: number | null; netout: number | null; diskread: number | null; diskwrite: number | null }
export interface MetricSeries { range: MetricRange; points: MetricPoint[] }
export interface TaskEntry { upid: string; node: string; type: string; id: string; user: string; status: string | null; start: number; end: number | null }
export interface BackupEntry { volid: string; storage: string; size: number; ctime: number; notes: string | null }
export type GuestRef = { kind: "guest"; node: string; vmid: number; type: GuestType };
export type TargetRef = { kind: "host"; node: string } | GuestRef;

export interface InfraProvider {
  readonly kind: "proxmox";
  inventory(signal: AbortSignal): Promise<Inventory>;
  hostDetail(node: string, signal: AbortSignal): Promise<HostDetail>;
  guestDetail(ref: GuestRef, signal: AbortSignal): Promise<GuestDetail>;
  metrics(target: TargetRef, range: MetricRange, signal: AbortSignal): Promise<MetricSeries>;
  tasks(target: TargetRef, limit: number, signal: AbortSignal): Promise<TaskEntry[]>;
  backups(ref: GuestRef, signal: AbortSignal): Promise<BackupEntry[]>;
  webUrl(target: TargetRef | null): string;
  version(signal: AbortSignal): Promise<string | null>;
}
