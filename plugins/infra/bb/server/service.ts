// One read model behind every surface: RPC (UI), `bb infra` (agents), @infra mentions, and pinned instructions.
import type {
  ActivityDto, AskIntent, ChangeDto, ConnectionDto, ConnectionSaveInput, EnvBadgeDto, EnvSaveInput, EnvSummary, EnvViewDto, ThreadStatusDto, ThreadTargetDto,
} from "../schemas.ts";
import type { Activity } from "./activity.ts";
import { Conventions } from "./conventions.ts";
import { envCard, envHealth, envIndexLine, guestCard, hostCard, registryMarkdown } from "./context.ts";
import type { EnvSnapshot, Hub } from "./hub.ts";
import type { Pins } from "./pins.ts";
import type { CertInfo } from "./providers/proxmox/tls.ts";
import type { GuestDetail, GuestRef, GuestState, HostState, InfraProvider, MetricRange } from "./providers/types.ts";
import type { Secrets } from "./secrets.ts";
import type { ActivityRow, ChangeRow, InfraEnvRow, PinRow, Store } from "./store.ts";
import { parseTarget } from "./targets.ts";

export interface ServiceDeps {
  conventions?: Conventions;
  store: Store;
  hub: Hub;
  activity: Activity;
  pins: Pins;
  secrets: Secrets;
  now(): number;
  probe(baseUrl: string): Promise<CertInfo>;
  onConfigChanged(): Promise<void>;
}

export type Resolved =
  | { kind: "env"; target: string; snap: EnvSnapshot }
  | { kind: "host"; target: string; snap: EnvSnapshot; host: HostState & { connectionId: string }; provider: InfraProvider | null }
  | { kind: "guest"; target: string; snap: EnvSnapshot; guest: GuestState & { connectionId: string }; ref: GuestRef; provider: InfraProvider | null };

const DETAIL_TTL = 30_000;
const ACTIVE_WINDOW_MS = 5 * 60_000;
const RECENT_ROW_MS = 30 * 60_000;
const INTENT_LINES: Record<AskIntent, string> = {
  ask: "Answer my question about",
  investigate: "Investigate the current state of",
  troubleshoot: "Troubleshoot problems with",
};

export const badge = (e: InfraEnvRow): EnvBadgeDto => ({ slug: e.slug, name: e.name, kind: e.kind, color: e.color });
const actDto = (a: ActivityRow): ActivityDto => ({ threadId: a.threadId, itemId: a.itemId, target: a.target, command: a.command, phase: a.phase, exitCode: a.exitCode, at: a.at });
const changeDto = (c: ChangeRow): ChangeDto => ({ target: c.target, kind: c.kind, detail: c.detail, threadId: c.threadId, at: c.at });
const underTarget = (t: string, prefix: string) => t === prefix || t.startsWith(prefix + "/");

/** One row per command run and target: the completed row when present, else the started one. Order is kept. */
export function collapseRuns(rows: ActivityDto[]): ActivityDto[] {
  const completed = new Set(rows.filter((r) => r.phase === "completed").map((r) => `${r.threadId}|${r.itemId}|${r.target}`));
  return rows.filter((r) => r.phase === "completed" || !completed.has(`${r.threadId}|${r.itemId}|${r.target}`));
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class InfraService {
  private readonly d: ServiceDeps;

  private readonly conv: Conventions;

  constructor(deps: ServiceDeps) {
    this.d = deps;
    this.conv = deps.conventions ?? new Conventions(deps.now);
  }

  private combineRules(env: InfraEnvRow, file: string | null): string {
    const parts = [env.rules.trim()];
    if (env.conventionsPath) parts.push(file === null ? `(conventions file ${env.conventionsPath} is loading)` : `Conventions (${env.conventionsPath}):\n${file.trim()}`);
    return parts.filter(Boolean).join("\n\n");
  }

  /** Inline rules plus the linked conventions file, from cache (synchronous callers). */
  private rulesSync(env: InfraEnvRow): string {
    return this.combineRules(env, env.conventionsPath ? this.conv.cached(env.conventionsPath) : null);
  }

  /** Inline rules plus the freshly read conventions file. */
  async rulesText(slug: string): Promise<string | null> {
    const env = this.d.hub.snapshot(slug)?.env;
    if (!env) return null;
    return this.combineRules(env, env.conventionsPath ? await this.conv.load(env.conventionsPath) : null);
  }

  /** Pre-read every linked conventions file so pinned instructions include them. */
  async warmConventions(): Promise<void> {
    await Promise.all(this.d.hub.snapshots().map((s) => this.warmRules(s.env.slug)));
  }

  private async warmRules(slug: string): Promise<void> {
    const path = this.d.hub.snapshot(slug)?.env.conventionsPath;
    if (path) await this.conv.load(path);
  }

  resolve(target: string): Resolved | null {
    const p = parseTarget(target);
    const snap = p && this.d.hub.snapshot(p.env);
    if (!p || !snap) return null;
    if (p.node === undefined) return { kind: "env", target: snap.env.slug, snap };
    const host = snap.hosts.find((h) => h.node.toLowerCase() === p.node!.toLowerCase());
    if (!host) return null;
    if (p.vmid === undefined) return { kind: "host", target: `${snap.env.slug}/${host.node}`, snap, host, provider: this.d.hub.provider(host.connectionId) };
    const guest = snap.guests.find((g) => g.vmid === p.vmid && g.node === host.node);
    if (!guest) return null;
    return {
      kind: "guest", target: `${snap.env.slug}/${host.node}/${guest.vmid}`, snap, guest,
      ref: { kind: "guest", node: guest.node, vmid: guest.vmid, type: guest.type }, provider: this.d.hub.provider(guest.connectionId),
    };
  }

  private recent(target: string, limit = 20): ActivityRow[] {
    return this.d.store.activityFor({ targetPrefix: target, limit });
  }

  private async guestDetail(r: Extract<Resolved, { kind: "guest" }>): Promise<GuestDetail> {
    if (!r.provider) throw new Error("connection unavailable");
    const provider = r.provider;
    const detail = await this.d.hub.cached(`guest:${r.target}`, DETAIL_TTL, () => provider.guestDetail(r.ref, AbortSignal.timeout(10_000)));
    this.d.hub.recordIps(r.target, detail.interfaces.flatMap((i) => i.ipv4));
    return detail;
  }

  // ---- context (agents) ----

  envIndex(): string {
    const snaps = this.d.hub.snapshots();
    return snaps.length ? snaps.map(envIndexLine).join("\n") : "No infra environments are configured.";
  }

  /** Card without on-demand detail; synchronous for contributeInstructions. */
  cardSync(target: string, o: { budget: number; rules: boolean }): string | null {
    const r = this.resolve(target);
    if (!r) return null;
    const ips = this.d.hub.guestIps();
    const now = this.d.now();
    let card: string | null;
    if (r.kind === "env") card = envCard({ ...r.snap, env: { ...r.snap.env, rules: this.rulesSync(r.snap.env) } }, { rules: o.rules, budget: o.budget, ips });
    else if (r.kind === "host") card = hostCard(r.snap, r.host.node, this.recent(r.target, 3), { budget: o.budget, now });
    else card = guestCard(r.snap, r.guest.node, r.guest.vmid, null, this.recent(r.target, 3), { budget: o.budget, ips, now });
    const rules = o.rules ? this.rulesSync(r.snap.env) : "";
    if (card && r.kind !== "env" && rules) card += `\nRules (${r.snap.env.slug}):\n${rules}`;
    return card;
  }

  /** Card including live guest detail when reachable. */
  async card(target: string, o: { budget: number; rules: boolean }): Promise<string | null> {
    if (o.rules) await this.warmRules(target.split("/")[0]!);
    const r = this.resolve(target);
    if (!r || r.kind !== "guest") return this.cardSync(target, o);
    const detail = await this.guestDetail(r).catch(() => null);
    let card = guestCard(r.snap, r.guest.node, r.guest.vmid, detail, this.recent(r.target, 3), { budget: o.budget, ips: this.d.hub.guestIps(), now: this.d.now() });
    const rules = o.rules ? this.rulesSync(r.snap.env) : "";
    if (card && rules) card += `\nRules (${r.snap.env.slug}):\n${rules}`;
    return card;
  }

  renderPin(pin: PinRow): string {
    return pin.targets.map((t) => this.cardSync(t, { budget: 40, rules: false }) ?? `${t}: not found`).join("\n\n")
      + (pin.rulesIncluded ? this.pinRules(pin) : "");
  }

  private pinRules(pin: PinRow): string {
    const slugs = [...new Set(pin.targets.map((t) => t.split("/")[0]!))];
    return slugs
      .map((slug) => this.d.hub.snapshot(slug)?.env)
      .filter((e): e is InfraEnvRow => !!e && !!this.rulesSync(e))
      .map((e) => `\n\nRules (${e.slug}):\n${this.rulesSync(e)}`)
      .join("");
  }

  registry(slug: string): string | null {
    const s = this.d.hub.snapshot(slug);
    return s ? registryMarkdown(s, this.d.hub.guestIps()) : null;
  }

  rules(slug: string): Promise<string | null> {
    return this.rulesText(slug);
  }

  activityText(target: string, sinceMs: number, limit: number): ActivityDto[] {
    return collapseRuns(this.d.store.activityFor({ targetPrefix: target, since: this.d.now() - sinceMs, limit: limit * 2 }).map(actDto)).slice(0, limit);
  }

  async askPrompt(target: string, intent: AskIntent): Promise<string | null> {
    const r = this.resolve(target);
    if (!r) return null;
    const card = await this.card(r.target, { budget: 40, rules: false });
    const env = r.snap.env;
    const parts = [
      `${INTENT_LINES[intent]} ${r.target} in the ${env.name} (${env.kind}) environment.`,
      "",
      card ?? "",
      "",
      "Environment rules:",
      (await this.rulesText(env.slug)) || "(none)",
      "",
      `Use your normal tools (ssh, bash) to operate; the Infra plugin is read-only context. Run \`bb infra context ${r.target}\` for fresher data.`,
    ];
    if (env.kind === "prod") parts.push("This is a production environment: confirm with me before making changes.");
    return parts.join("\n");
  }

  // ---- views (UI) ----

  private activeThreads(slug: string): string[] {
    const running = [...this.d.activity.running()].filter(([, ts]) => ts.some((t) => underTarget(t, slug))).map(([id]) => id);
    return [...new Set([...running, ...this.d.activity.threadsTouching(slug, ACTIVE_WINDOW_MS)])];
  }

  overview(): { envs: EnvSummary[] } {
    return {
      envs: this.d.hub.snapshots().map((s) => {
        const guests = s.guests.filter((g) => !g.template);
        const stale = s.connections.map((c) => c.health.staleSince).filter((x): x is number => x !== null);
        return {
          env: badge(s.env),
          hosts: { up: s.hosts.filter((h) => h.online).length, total: s.hosts.length },
          guests: { running: guests.filter((g) => g.state === "running").length, total: guests.length },
          health: envHealth(s),
          staleSince: stale.length ? Math.min(...stale) : null,
          activeThreads: this.activeThreads(s.env.slug),
        };
      }),
    };
  }

  envView(slug: string): EnvViewDto | null {
    const s = this.d.hub.snapshot(slug);
    if (!s) return null;
    const ips = this.d.hub.guestIps();
    const since = this.d.now() - ACTIVE_WINDOW_MS;
    const recent = this.d.store.activityFor({ envId: s.env.id, limit: 200 });
    const activeTargets = new Set(recent.filter((a) => a.at >= since).map((a) => a.target));
    for (const ts of this.d.activity.running().values()) ts.forEach((t) => activeTargets.add(t));
    return {
      env: badge(s.env),
      health: envHealth(s),
      connections: s.connections,
      hosts: s.hosts,
      guests: s.guests.map((g) => ({ ...g, ips: ips.get(`${slug}/${g.node}/${g.vmid}`) ?? [], active: activeTargets.has(`${slug}/${g.node}/${g.vmid}`) })),
      storage: s.storage,
      updatedAt: s.updatedAt,
      recentActivity: recent.slice(0, 20).map(actDto),
    };
  }

  async hostView(target: string) {
    const r = this.resolve(target);
    if (!r || r.kind !== "host" || !r.provider) return null;
    const provider = r.provider;
    const node = r.host.node;
    const [detail, tasks] = await Promise.all([
      this.d.hub.cached(`host:${r.target}`, DETAIL_TTL, () => provider.hostDetail(node, AbortSignal.timeout(10_000))),
      this.d.hub.cached(`tasks:${r.target}`, DETAIL_TTL, () => provider.tasks({ kind: "host", node }, 20, AbortSignal.timeout(10_000))).catch(() => []),
    ]);
    detail.host.ip = r.host.ip;
    detail.host.online = r.host.online;
    return {
      env: badge(r.snap.env), detail, guests: r.snap.guests.filter((g) => g.node === node), tasks,
      activity: this.recent(r.target, 50).map(actDto), webUrl: provider.webUrl({ kind: "host", node }),
    };
  }

  async guestView(target: string) {
    const r = this.resolve(target);
    if (!r || r.kind !== "guest" || !r.provider) return null;
    const detail = await this.guestDetail(r);
    return {
      env: badge(r.snap.env), detail, activity: this.recent(r.target, 50).map(actDto),
      changes: this.d.store.changes({ envId: r.snap.env.id, limit: 500 }).filter((c) => c.target === r.target).slice(0, 20).map(changeDto),
      webUrl: r.provider.webUrl(r.ref),
    };
  }

  guestSummary(target: string) {
    const r = this.resolve(target);
    if (!r || r.kind !== "guest") return null;
    const running = [...this.d.activity.running().values()].some((ts) => ts.includes(r.target));
    return { env: badge(r.snap.env), guest: r.guest, ips: this.d.hub.guestIps().get(r.target) ?? [], running };
  }

  hostSummary(target: string) {
    const r = this.resolve(target);
    if (!r || r.kind !== "host") return null;
    const guests = r.snap.guests.filter((g) => g.node === r.host.node && !g.template);
    const running = [...this.d.activity.running().values()].some((ts) => ts.some((t) => underTarget(t, r.target)));
    return { env: badge(r.snap.env), host: r.host, guests: { running: guests.filter((g) => g.state === "running").length, total: guests.length }, running };
  }

  async guestExtras(target: string, tab: "tasks" | "backups") {
    const r = this.resolve(target);
    if (!r || r.kind !== "guest" || !r.provider) return null;
    const provider = r.provider;
    if (tab === "tasks") return { tasks: await this.d.hub.cached(`tasks:${r.target}`, DETAIL_TTL, () => provider.tasks(r.ref, 30, AbortSignal.timeout(10_000))) };
    return { backups: await this.d.hub.cached(`backups:${r.target}`, 5 * 60_000, () => provider.backups(r.ref, AbortSignal.timeout(20_000))) };
  }

  async metrics(target: string, range: MetricRange) {
    const r = this.resolve(target);
    if (!r || r.kind === "env" || !r.provider) return null;
    const provider = r.provider;
    const ref = r.kind === "host" ? { kind: "host" as const, node: r.host.node } : r.ref;
    return this.d.hub.cached(`rrd:${r.target}:${range}`, DETAIL_TTL, () => provider.metrics(ref, range, AbortSignal.timeout(10_000)));
  }

  activity(q: { envSlug?: string; target?: string; threadId?: string; limit: number }): { items: ActivityDto[]; changes: ChangeDto[] } {
    const envId = q.envSlug ? this.d.hub.snapshot(q.envSlug)?.env.id : undefined;
    if (q.envSlug && !envId) return { items: [], changes: [] };
    const items = this.d.store.activityFor({ envId, targetPrefix: q.target, threadId: q.threadId, limit: q.limit }).map(actDto);
    const changes = q.threadId
      ? []
      : this.d.store.changes({ envId, limit: q.limit * 4 }).filter((c) => !q.target || underTarget(c.target, q.target)).slice(0, q.limit).map(changeDto);
    return { items, changes };
  }

  threadTargets(threadId: string): ThreadTargetDto[] {
    const rows = this.d.store.activityFor({ threadId, limit: 500 });
    const running = new Set(this.d.activity.running().get(threadId) ?? []);
    const seen = new Map<string, number>();
    for (const a of rows) if (!seen.has(a.target)) seen.set(a.target, a.at);
    const out: ThreadTargetDto[] = [];
    for (const [target, lastAt] of seen) {
      const r = this.resolve(target);
      if (!r) continue;
      const label = r.kind === "guest" ? `${r.guest.name} (${r.guest.vmid})` : r.kind === "host" ? r.host.node : r.snap.env.name;
      const state = r.kind === "guest" ? r.guest.state : r.kind === "host" ? (r.host.online ? "online" : "offline") : null;
      out.push({ target: r.target, env: badge(r.snap.env), label, kind: r.kind, state, running: running.has(r.target), lastAt });
    }
    return out;
  }

  /**
   * Sidebar row status per thread: running commands, then recent infra work. BB draws its own spinner
   * over busy threads, so the recent-work status is what a person sees once the agent is done.
   */
  threadStatuses(windowMs = RECENT_ROW_MS): ThreadStatusDto[] {
    const running = this.d.activity.running();
    const rows = this.d.store.activityFor({ since: this.d.now() - windowMs, limit: 2000 });
    const byThread = new Map<string, { targets: string[]; lastExit: number | null | undefined; lastAt: number }>();
    for (const a of rows) {
      const t = byThread.get(a.threadId) ?? { targets: [], lastExit: undefined, lastAt: a.at };
      if (!t.targets.includes(a.target)) t.targets.push(a.target);
      if (t.lastExit === undefined && a.phase === "completed") t.lastExit = a.exitCode;
      byThread.set(a.threadId, t);
    }
    for (const [threadId, targets] of running) if (!byThread.has(threadId)) byThread.set(threadId, { targets, lastExit: undefined, lastAt: this.d.now() });
    return [...byThread].map(([threadId, t]) => ({
      threadId,
      labels: t.targets.map((x) => this.shortLabel(x)).filter((x): x is string => !!x),
      state: running.has(threadId) ? "running" : t.lastExit !== undefined && t.lastExit !== null && t.lastExit !== 0 ? "failed" : "ok",
      lastAt: t.lastAt,
    }));
  }

  private shortLabel(target: string): string | null {
    const r = this.resolve(target);
    if (!r) return null;
    return r.kind === "guest" ? r.guest.name : r.kind === "host" ? r.host.node : r.snap.env.name;
  }

  // ---- settings (UI) ----

  async settings(): Promise<{ envs: InfraEnvRow[]; connections: ConnectionDto[] }> {
    const connections = await Promise.all(this.d.store.listConnections().map((c) => this.connectionDto(c.id)));
    return { envs: this.d.store.listEnvs(), connections: connections.filter((c): c is ConnectionDto => !!c) };
  }

  private async connectionDto(id: string): Promise<ConnectionDto | null> {
    const c = this.d.store.getConnection(id);
    if (!c) return null;
    const { caPem, ...rest } = c;
    return { ...rest, hasCaPem: caPem.trim() !== "", hasSecret: await this.d.secrets.has(c.id), health: this.d.hub.health(c.id) };
  }

  async saveEnv(input: EnvSaveInput): Promise<InfraEnvRow> {
    const env = this.d.store.upsertEnv(input);
    await this.d.onConfigChanged();
    await this.warmRules(env.slug);
    return env;
  }

  async deleteEnv(id: string): Promise<void> {
    for (const c of this.d.store.listConnections(id)) await this.d.secrets.remove(c.id);
    this.d.store.deleteEnv(id);
    await this.d.onConfigChanged();
  }

  async saveConnection(input: ConnectionSaveInput): Promise<ConnectionDto> {
    const { secret, caPem, ...fields } = input;
    const existing = input.id ? this.d.store.getConnection(input.id) : null;
    if (input.id && !existing) throw new NotFoundError("connection not found");
    if (fields.tlsMode === "pinned" && !fields.tlsFingerprint.trim()) throw new Error("fetch and trust the certificate fingerprint first");
    const row = this.d.store.upsertConnection({ ...fields, caPem: caPem ?? existing?.caPem ?? "" });
    if (fields.tlsMode === "ca" && !row.caPem.trim()) throw new Error("paste the CA certificate (PEM)");
    if (secret) await this.d.secrets.set(row.id, secret);
    await this.d.onConfigChanged();
    return (await this.connectionDto(row.id))!;
  }

  async deleteConnection(id: string): Promise<void> {
    await this.d.secrets.remove(id);
    this.d.store.deleteConnection(id);
    await this.d.onConfigChanged();
  }

  async probe(baseUrl: string): Promise<{ ok: true; cert: CertInfo } | { ok: false; error: string }> {
    try {
      return { ok: true, cert: await this.d.probe(baseUrl) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async testConnection(id: string): Promise<{ health: ReturnType<Hub["health"]>; version: string | null }> {
    const provider = this.d.hub.provider(id);
    let version: string | null = null;
    if (provider) {
      await this.d.hub.tick(id, AbortSignal.timeout(10_000));
      version = await provider.version(AbortSignal.timeout(10_000)).catch(() => null);
    }
    return { health: this.d.hub.health(id), version };
  }
}
