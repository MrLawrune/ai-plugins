// Playbook library: reads playbook files from the control host through the host entry, parses and caches
// summaries, and keeps cards fresh by re-reading the files a thread touched (spec §6.2).
import { LIMITS } from "../shared/constants.ts";
import type { PlaybookSummary } from "../shared/types.ts";
import type { HostClient } from "./runs.ts";
import { parsePlaybook } from "./parser/parse.ts";
import type { InventoryRow, PlaybooksEnvRow, Store, ThreadFileRow } from "./store.ts";
import { isSafeRelativePath } from "./targets.ts";
import { inventoryPrefix } from "./envs.ts";

export const SUMMARY_TTL_MS = 5000;
export const ACTIVITY_THROTTLE_MS = 1000;
const LIST_CONCURRENCY = 8;

export type SummaryResult = { summary: PlaybookSummary; content: string } | { notFound: true } | { unreachable: string };
export interface LibraryEntry { path: string; name: string; counts: PlaybookSummary["counts"]; lastRun: { id: string; status: string; at: number } | null }

interface CacheEntry { hash: string; summary: PlaybookSummary; content: string; at: number }

export interface LibraryDeps {
  store: Store;
  host: HostClient;
  now(): number;
  resolveEnv(slug: string): { env: PlaybooksEnvRow; hostId: string } | null;
  publishChanged(payload: { envId: string; paths: string[] }): void;
  log?(level: "warn", message: string, data?: Record<string, unknown>): void;
  /** Timer seam for the trailing throttle re-check; defaults to setTimeout. */
  setTimer?(fn: () => void, ms: number): { clear(): void };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class LibraryService {
  private readonly d: LibraryDeps;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastActivity = new Map<string, number>();
  private readonly pending = new Map<string, { clear(): void }>();

  constructor(d: LibraryDeps) {
    this.d = d;
  }

  async summary(envSlug: string, path: string, opts: { threadId?: string; force?: boolean } = {}): Promise<SummaryResult> {
    const r = this.d.resolveEnv(envSlug);
    if (!r || !isSafeRelativePath(path)) return { notFound: true };
    const touch = (): void => { if (opts.threadId) this.d.store.touchThreadFile(opts.threadId, r.env.id, path); };
    const key = `${r.env.id}\0${path}`;
    const hit = this.cache.get(key);
    if (hit && !opts.force && this.d.now() - hit.at < SUMMARY_TTL_MS) { touch(); return { summary: hit.summary, content: hit.content }; }
    const res = await this.read(r.env, r.hostId, path);
    if ("notFound" in res || "unreachable" in res) {
      if ("notFound" in res) this.cache.delete(key);
      return res;
    }
    touch();
    if (res.changed) this.d.publishChanged({ envId: r.env.id, paths: [path] });
    return { summary: res.summary, content: res.content };
  }

  /** Fetch, parse, and cache one file. Not-found is distinguished from transport failure by the host error text. */
  private async read(env: PlaybooksEnvRow, hostId: string, path: string): Promise<(CacheEntry & { changed: boolean }) | { notFound: true } | { unreachable: string }> {
    try {
      const f = await this.d.host.call("readFile", { controlHost: env.controlHost, repoPath: env.repoPath, path }, { hostId });
      const summary = parsePlaybook(env.slug, path, f.content);
      const entry: CacheEntry = { hash: f.hash, summary, content: f.content, at: this.d.now() };
      const key = `${env.id}\0${path}`;
      const before = this.cache.get(key)?.hash;
      this.cache.set(key, entry);
      return { ...entry, changed: before !== undefined && before !== f.hash };
    } catch (e) {
      const m = message(e);
      return /not[_ ]found|no such file/i.test(m) ? { notFound: true } : { unreachable: m };
    }
  }

  /** One ssh session lists every playbook with its hash; only files whose hash is not cached are read (in small batches). */
  async list(envSlug: string): Promise<LibraryEntry[]> {
    const r = this.d.resolveEnv(envSlug);
    if (!r) return [];
    const { files } = await this.d.host.call("hashPlaybooks", { controlHost: r.env.controlHost, repoPath: r.env.repoPath }, { hostId: r.hostId });
    const now = this.d.now();
    const stale: string[] = [];
    for (const f of files) {
      const hit = this.cache.get(`${r.env.id}\0${f.path}`);
      if (hit && hit.hash === f.hash) { hit.at = now; continue; } // the listing just confirmed it
      if (f.bytes <= LIMITS.readFile) stale.push(f.path);
    }
    const changed: string[] = [];
    for (let i = 0; i < stale.length; i += LIST_CONCURRENCY) {
      const batch = await Promise.all(stale.slice(i, i + LIST_CONCURRENCY).map(async (path) => ({ path, res: await this.read(r.env, r.hostId, path) })));
      for (const { path, res } of batch) if ("changed" in res && res.changed) changed.push(path);
    }
    if (changed.length) this.d.publishChanged({ envId: r.env.id, paths: changed });
    const out: LibraryEntry[] = [];
    for (const f of files) {
      const hit = this.cache.get(`${r.env.id}\0${f.path}`);
      if (!hit || hit.summary.error || hit.summary.plays.length === 0) continue;
      const run = this.d.store.listRuns({ envId: r.env.id, playbook: f.path, limit: 1 })[0];
      out.push({ path: f.path, name: hit.summary.name, counts: hit.summary.counts, lastRun: run ? { id: run.id, status: run.status, at: run.requestedAt } : null });
    }
    return out;
  }

  async discoverInventories(envSlug: string): Promise<InventoryRow[]> {
    const r = this.d.resolveEnv(envSlug);
    if (!r) return [];
    // The host lists paths relative to the inventory root; stored paths are repo-relative (what `-i` and readFile take from repoPath).
    const prefix = inventoryPrefix(r.env.repoPath, r.env.inventoryRoot);
    if (prefix === null) throw new Error(`inventory folder ${r.env.inventoryRoot} is outside the repository ${r.env.repoPath}; fix the environment in its settings`);
    const inventoryRoot = r.env.inventoryRoot.trim() === "" ? r.env.repoPath : r.env.inventoryRoot;
    const { entries } = await this.d.host.call("discoverInventories", { controlHost: r.env.controlHost, inventoryRoot }, { hostId: r.hostId });
    const rel = (p: string): string => (prefix ? `${prefix}/${p}` : p);
    this.d.store.replaceDiscoveredInventories(r.env.id, entries.map((e) => ({ name: e.path.split("/").pop() ?? e.path, kind: e.kind, path: rel(e.path) })));
    return this.d.store.listInventories(r.env.id);
  }

  /** ansible-inventory --list for one inventory; the group names are cached on its row. */
  async resolveInventory(envSlug: string, path: string): Promise<{ groups: string[]; hosts: string[] } | null> {
    const r = this.d.resolveEnv(envSlug);
    if (!r) return null;
    const { json } = await this.d.host.call("resolveInventory", { controlHost: r.env.controlHost, repoPath: r.env.repoPath, inventory: path }, { hostId: r.hostId });
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json) as Record<string, unknown>;
    } catch (e) {
      this.d.log?.("warn", "ansible-inventory output is not JSON", { path, error: message(e) });
      return { groups: [], hosts: [] };
    }
    const meta = parsed._meta as { hostvars?: Record<string, unknown> } | undefined;
    const groups = Object.keys(parsed).filter((k) => k !== "_meta");
    const hosts = new Set(Object.keys(meta?.hostvars ?? {}));
    for (const g of groups) for (const h of (parsed[g] as { hosts?: unknown } | null)?.hosts as string[] ?? []) hosts.add(h);
    const row = this.d.store.listInventories(r.env.id).find((i) => i.path === path)
      ?? this.d.store.upsertInventory({ envId: r.env.id, name: path.split("/").pop() ?? path, kind: "file", path, defaultLimit: null, discovered: false });
    this.d.store.setInventoryGroups(row.id, JSON.stringify(groups));
    return { groups, hosts: [...hosts] };
  }

  /** Playbooks parsed recently (the cache), for the mention search. */
  cachedFiles(): { envId: string; path: string; name: string }[] {
    return [...this.cache.entries()].map(([key, e]) => {
      const [envId, path] = key.split("\0") as [string, string];
      return { envId, path, name: e.summary.name };
    });
  }

  threadFiles(threadId: string): ThreadFileRow[] {
    return this.d.store.threadFiles(threadId);
  }

  /**
   * Re-check the files this thread has touched and publish the ones whose content changed since they were last cached.
   * One hash listing per environment says which files changed; only those (and files the listing does not cover,
   * such as group_vars or a deleted file) are read.
   */
  async onThreadActivity(threadId: string): Promise<void> {
    const at = this.d.now();
    const last = this.lastActivity.get(threadId);
    if (last !== undefined && at - last < ACTIVITY_THROTTLE_MS) {
      // Inside the window: remember the edit and re-check once when it expires, so a trailing change is not lost.
      if (!this.pending.has(threadId)) {
        const timer = this.d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) }; });
        this.pending.set(threadId, timer(() => { this.pending.delete(threadId); void this.onThreadActivity(threadId); }, ACTIVITY_THROTTLE_MS - (at - last)));
      }
      return;
    }
    this.lastActivity.set(threadId, at);
    const changed = new Map<string, string[]>();
    const listings = new Map<string, Map<string, string> | null>(); // envId → path → hash (null: listing failed, read each file)
    for (const f of this.threadFiles(threadId)) {
      const env = this.d.store.getEnv(f.envId);
      if (!env) continue;
      const r = this.d.resolveEnv(env.slug);
      if (!r) continue;
      if (!listings.has(env.id)) {
        listings.set(env.id, await this.d.host.call("hashPlaybooks", { controlHost: env.controlHost, repoPath: env.repoPath }, { hostId: r.hostId })
          .then((l) => new Map(l.files.map((x) => [x.path, x.hash])), () => null));
      }
      const key = `${env.id}\0${f.path}`;
      const before = this.cache.get(key)?.hash; // no baseline: this read seeds it and publishes nothing
      const listed = listings.get(env.id)?.get(f.path);
      if (before !== undefined && listed !== undefined && listed === before) continue; // unchanged per the listing
      const res = await this.read(env, r.hostId, f.path);
      if ("unreachable" in res) continue;
      const hash = "notFound" in res ? null : res.hash;
      if (before !== undefined && before !== hash) changed.set(env.id, [...(changed.get(env.id) ?? []), f.path]);
      if ("notFound" in res) this.cache.delete(key);
    }
    for (const [envId, paths] of changed) this.d.publishChanged({ envId, paths });
  }

  dispose(): void {
    for (const t of this.pending.values()) t.clear();
    this.pending.clear();
  }
}
