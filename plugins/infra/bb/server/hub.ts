// Polls every connection, merges per-InfraEnv snapshots, diffs them into change events,
// tracks connection health with backoff, and caches on-demand detail.
import { PveError } from "./providers/proxmox/client.ts";
import type { ConnectionHealth, GuestState, HostState, InfraProvider, Inventory, StoragePool } from "./providers/types.ts";
import type { ChangeKind, ConnectionRow, InfraEnvRow, Store } from "./store.ts";

export interface EnvSnapshot {
  env: InfraEnvRow;
  hosts: (HostState & { connectionId: string })[];
  guests: (GuestState & { connectionId: string })[];
  storage: StoragePool[];
  connections: { id: string; label: string; health: ConnectionHealth }[];
  updatedAt: number | null;
}

export interface ChangeEvent { id?: number; envId: string; target: string; kind: ChangeKind; detail: string; threadId?: string | null; at: number }

export interface HubDeps {
  store: Store;
  providerFor(conn: ConnectionRow): Promise<InfraProvider>;
  now(): number;
  onChange(events: ChangeEvent[]): void;
  onSnapshot(envId: string): void;
  log(msg: string): void;
}

interface ConnState {
  row: ConnectionRow;
  provider: InfraProvider | null;
  inventory: Inventory | null;
  health: ConnectionHealth;
  failures: number;
  ipsAt: number;
}

const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 300_000;
const IP_CONCURRENCY = 4;

const initialHealth = (): ConnectionHealth => ({ code: "ok", message: null, lastOkAt: null, staleSince: null });

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class Hub {
  private readonly deps: HubDeps;
  private envs: InfraEnvRow[] = [];
  private conns = new Map<string, ConnState>();
  private snaps = new Map<string, EnvSnapshot>(); // by env id
  private cache = new Map<string, { at: number; value?: unknown; pending?: Promise<unknown> }>();
  private ips = new Map<string, string[]>();
  private generation = new AbortController();

  constructor(deps: HubDeps) {
    this.deps = deps;
  }

  /** Re-read environments and connections; keeps inventories and snapshots of connections that still exist. */
  async reload(): Promise<void> {
    this.envs = this.deps.store.listEnvs();
    const rows = this.deps.store.listConnections();
    const next = new Map<string, ConnState>();
    for (const row of rows) {
      const prev = this.conns.get(row.id);
      const state: ConnState = { row, provider: null, inventory: prev?.inventory ?? null, health: prev?.health ?? initialHealth(), failures: 0, ipsAt: prev?.ipsAt ?? 0 };
      if (!row.enabled) {
        state.health = { ...state.health, code: "disabled", message: null };
      } else {
        try {
          state.provider = await this.deps.providerFor(row);
          if (state.health.code === "disabled" || state.health.code === "auth-failed") state.health = { ...state.health, code: "ok", message: null };
        } catch (e) {
          state.health = { ...state.health, ...this.failureHealth(e) };
        }
      }
      next.set(row.id, state);
    }
    this.conns = next;
    const envIds = new Set(this.envs.map((e) => e.id));
    for (const id of [...this.snaps.keys()]) if (!envIds.has(id)) this.snaps.delete(id);
    for (const env of this.envs) this.rebuild(env, false);
    this.generation.abort();
    this.generation = new AbortController();
  }

  private failureHealth(e: unknown): Pick<ConnectionHealth, "code" | "message"> {
    if (e instanceof PveError) return { code: e.code, message: e.message };
    return { code: "unreachable", message: e instanceof Error ? e.message : String(e) };
  }

  async tick(connectionId: string, signal: AbortSignal): Promise<void> {
    const c = this.conns.get(connectionId);
    if (!c || !c.provider) return;
    const now = this.deps.now();
    try {
      c.inventory = await c.provider.inventory(signal);
      c.health = { code: "ok", message: null, lastOkAt: now, staleSince: null };
      c.failures = 0;
    } catch (e) {
      if (signal.aborted) return;
      c.failures++;
      c.health = { ...this.failureHealth(e), lastOkAt: c.health.lastOkAt, staleSince: c.health.staleSince ?? now };
    }
    const env = this.envs.find((x) => x.id === c.row.envId);
    if (env) this.rebuild(env, true);
  }

  nextDelayMs(connectionId: string): number {
    const c = this.conns.get(connectionId);
    const env = c && this.envs.find((x) => x.id === c.row.envId);
    if (!c || c.failures === 0) return (env?.pollSeconds ?? 10) * 1000;
    return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (c.failures - 1));
  }

  private rebuild(env: InfraEnvRow, emit: boolean): void {
    const conns = [...this.conns.values()].filter((c) => c.row.envId === env.id).sort((a, b) => a.row.label.localeCompare(b.row.label));
    const owner = new Map<string, string>(); // lowercased node → connection label
    const snap: EnvSnapshot = { env, hosts: [], guests: [], storage: [], connections: [], updatedAt: null };
    for (const c of conns) {
      let health = c.health;
      if (c.inventory) {
        const dup = c.inventory.hosts.find((h) => owner.has(h.node.toLowerCase()));
        if (dup) {
          health = { ...health, code: "degraded", message: `duplicate node ${dup.node} also reported by ${owner.get(dup.node.toLowerCase())}` };
        } else {
          for (const h of c.inventory.hosts) { owner.set(h.node.toLowerCase(), c.row.label); snap.hosts.push({ ...h, connectionId: c.row.id }); }
          for (const g of c.inventory.guests) snap.guests.push({ ...g, connectionId: c.row.id });
          snap.storage.push(...c.inventory.storage);
        }
      }
      if (health.lastOkAt !== null) snap.updatedAt = Math.max(snap.updatedAt ?? 0, health.lastOkAt);
      snap.connections.push({ id: c.row.id, label: c.row.label, health });
    }
    snap.guests.sort((a, b) => a.node.localeCompare(b.node) || a.vmid - b.vmid);
    const prev = this.snaps.get(env.id);
    this.snaps.set(env.id, snap);
    if (!emit) return;
    const events = prev && prev.updatedAt !== null ? this.diff(prev, snap) : [];
    if (events.length) {
      const stored = events.map((e) => ({ ...e, id: this.deps.store.addChange({ envId: e.envId, target: e.target, kind: e.kind, detail: e.detail, threadId: null, at: e.at }).id }));
      this.deps.onChange(stored);
    }
    this.deps.onSnapshot(env.id);
  }

  private diff(prev: EnvSnapshot, next: EnvSnapshot): ChangeEvent[] {
    const at = this.deps.now();
    const slug = next.env.slug;
    const out: ChangeEvent[] = [];
    const key = (g: { node: string; vmid: number }) => `${g.node.toLowerCase()}/${g.vmid}`;
    // Only compare what the same connection reported in both snapshots: a connection's first poll,
    // recovery, or removal is a change in visibility, not in the infrastructure.
    const contributed = (s: EnvSnapshot) => new Set(s.hosts.map((h) => h.connectionId));
    const before0 = contributed(prev);
    const after0 = contributed(next);
    const comparable = (x: { connectionId: string }) => before0.has(x.connectionId) && after0.has(x.connectionId);
    const before = new Map(prev.guests.filter(comparable).map((g) => [key(g), g]));
    const after = new Map(next.guests.filter(comparable).map((g) => [key(g), g]));
    const ev = (target: string, kind: ChangeKind, detail: string) => out.push({ envId: next.env.id, target, kind, detail, at });
    for (const [k, g] of after) {
      const old = before.get(k);
      if (!old) ev(`${slug}/${g.node}/${g.vmid}`, "guest.added", `${g.name} (${g.type})`);
      else if (old.state !== g.state) ev(`${slug}/${g.node}/${g.vmid}`, "guest.state", `${old.state} → ${g.state}`);
    }
    for (const [k, g] of before) if (!after.has(k)) ev(`${slug}/${g.node}/${g.vmid}`, "guest.removed", `${g.name} (${g.type})`);
    const hostsBefore = new Map(prev.hosts.filter(comparable).map((h) => [h.node.toLowerCase(), h]));
    for (const h of next.hosts.filter(comparable)) {
      const old = hostsBefore.get(h.node.toLowerCase());
      if (old && old.online !== h.online) ev(`${slug}/${h.node}`, "host.state", `${old.online ? "online" : "offline"} → ${h.online ? "online" : "offline"}`);
    }
    return out;
  }

  snapshots(): EnvSnapshot[] {
    return this.envs.map((e) => this.snaps.get(e.id)).filter((s): s is EnvSnapshot => !!s);
  }

  snapshot(slug: string): EnvSnapshot | null {
    const env = this.envs.find((e) => e.slug === slug);
    return env ? this.snaps.get(env.id) ?? null : null;
  }

  provider(connectionId: string): InfraProvider | null {
    return this.conns.get(connectionId)?.provider ?? null;
  }

  health(connectionId: string): ConnectionHealth | null {
    return this.snapshots().flatMap((s) => s.connections).find((c) => c.id === connectionId)?.health ?? null;
  }

  connectionForNode(slug: string, node: string): string | null {
    const lower = node.toLowerCase();
    return this.snapshot(slug)?.hosts.find((h) => h.node.toLowerCase() === lower)?.connectionId ?? null;
  }

  async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    const now = this.deps.now();
    if (hit?.pending) return hit.pending as Promise<T>;
    if (hit && "value" in hit && now - hit.at < ttlMs) return hit.value as T;
    const pending = load().then(
      (value) => { this.cache.set(key, { at: this.deps.now(), value }); return value; },
      (e: unknown) => { this.cache.delete(key); throw e; },
    );
    this.cache.set(key, { at: now, pending });
    return pending;
  }

  guestIps(): ReadonlyMap<string, string[]> {
    return this.ips;
  }

  recordIps(target: string, ipv4: string[]): void {
    if (ipv4.length) this.ips.set(target, ipv4);
  }

  async refreshIps(connectionId: string, signal: AbortSignal): Promise<void> {
    const c = this.conns.get(connectionId);
    const env = c && this.envs.find((x) => x.id === c.row.envId);
    if (!c?.provider || !c.inventory || !env) return;
    c.ipsAt = this.deps.now();
    const queue = c.inventory.guests.filter((g) => g.state === "running" && !g.template);
    const provider = c.provider;
    const worker = async () => {
      for (let g = queue.shift(); g && !signal.aborted; g = queue.shift()) {
        try {
          const d = await provider.guestDetail({ kind: "guest", node: g.node, vmid: g.vmid, type: g.type }, signal);
          this.recordIps(`${env.slug}/${g.node}/${g.vmid}`, d.interfaces.flatMap((i) => i.ipv4));
        } catch {
          // keep the previous entry
        }
      }
    };
    await Promise.all(Array.from({ length: IP_CONCURRENCY }, worker));
  }

  /** True when this connection's environment sweeps guest IPs and the last sweep is older than its interval. */
  ipRefreshDue(connectionId: string): boolean {
    const c = this.conns.get(connectionId);
    const env = c && this.envs.find((x) => x.id === c.row.envId);
    if (!c || !env || env.ipRefreshMinutes <= 0) return false;
    return c.ipsAt === 0 || this.deps.now() - c.ipsAt >= env.ipRefreshMinutes * 60_000;
  }

  /** Poll every enabled connection on its own schedule until `signal` aborts; restarts when reload() changes the set. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const gen = AbortSignal.any([signal, this.generation.signal]);
      const ids = [...this.conns.values()].filter((c) => c.provider).map((c) => c.row.id);
      const loop = async (id: string, index: number) => {
        await sleep(index * 500, gen);
        while (!gen.aborted) {
          await this.tick(id, gen);
          const c = this.conns.get(id);
          if (c && c.failures === 0 && this.ipRefreshDue(id)) {
            await this.refreshIps(id, gen).catch((e: unknown) => this.deps.log(`ip refresh failed: ${String(e)}`));
          }
          await sleep(this.nextDelayMs(id), gen);
        }
      };
      if (ids.length) await Promise.all(ids.map(loop));
      else await sleep(60_000, gen);
    }
  }
}
