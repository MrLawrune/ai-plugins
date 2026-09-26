// Plugin-owned SQLite state: environments, connections, agent activity, change events, pins, cursors.
import { randomUUID } from "node:crypto";
import { ENV_KINDS, RULES_MAX, type EnvKind } from "../shared/constants.ts";
import { SLUG_RE } from "./targets.ts";

/** The subset of better-sqlite3 (host runtime) and node:sqlite (tests) the store uses. */
export interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqlDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

/** Append-only: never edit or reorder shipped statements. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE infra_envs (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL, color TEXT NOT NULL,
    poll_seconds INTEGER NOT NULL, rules TEXT NOT NULL, export_dir TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE connections (
    id TEXT PRIMARY KEY, env_id TEXT NOT NULL, label TEXT NOT NULL, base_url TEXT NOT NULL, auth_kind TEXT NOT NULL,
    username TEXT NOT NULL, tls_mode TEXT NOT NULL, tls_fingerprint TEXT NOT NULL, ca_pem TEXT NOT NULL, enabled INTEGER NOT NULL)`,
  `CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, env_id TEXT NOT NULL, target TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL, command TEXT NOT NULL, phase TEXT NOT NULL, exit_code INTEGER, at INTEGER NOT NULL,
    UNIQUE (thread_id, item_id, phase, target))`,
  `CREATE INDEX activity_target ON activity (env_id, target, at)`,
  `CREATE INDEX activity_thread ON activity (thread_id, at)`,
  `CREATE TABLE changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, env_id TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL,
    thread_id TEXT, at INTEGER NOT NULL)`,
  `CREATE INDEX changes_env ON changes (env_id, at)`,
  `CREATE TABLE scope_pins (thread_id TEXT PRIMARY KEY, targets TEXT NOT NULL, rules_included INTEGER NOT NULL, pinned_at INTEGER NOT NULL)`,
  `CREATE TABLE cursors (thread_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)`,
  `ALTER TABLE connections ADD COLUMN web_url TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE infra_envs ADD COLUMN ip_refresh_minutes INTEGER NOT NULL DEFAULT 5`,
  `ALTER TABLE infra_envs ADD COLUMN conventions_path TEXT NOT NULL DEFAULT ''`,
];

export { ENV_KINDS, RULES_MAX, type EnvKind } from "../shared/constants.ts";

export interface InfraEnvRow { id: string; slug: string; name: string; kind: EnvKind; color: string; pollSeconds: number; rules: string; exportDir: string; createdAt: number; ipRefreshMinutes: number; conventionsPath: string }
export interface ConnectionRow { id: string; envId: string; label: string; baseUrl: string; authKind: "token" | "password"; username: string; tlsMode: "pinned" | "ca" | "insecure"; tlsFingerprint: string; caPem: string; enabled: boolean; webUrl: string }
export interface ActivityRow { id: number; envId: string; target: string; threadId: string; turnId: string; itemId: string; command: string; phase: "started" | "completed"; exitCode: number | null; at: number }
export type ChangeKind = "guest.added" | "guest.removed" | "guest.state" | "host.state";
export interface ChangeRow { id: number; envId: string; target: string; kind: ChangeKind; detail: string; threadId: string | null; at: number }
export interface PinRow { threadId: string; targets: string[]; rulesIncluded: boolean; pinnedAt: number }

type Row = Record<string, unknown>;

/** Base for "Open in Proxmox" links: the browser-reachable web UI link when set, else the API URL. */
export const webBaseFor = (c: Pick<ConnectionRow, "baseUrl" | "webUrl">): string => c.webUrl.trim() || c.baseUrl;

const envFrom = (r: Row): InfraEnvRow => ({
  id: r.id as string, slug: r.slug as string, name: r.name as string, kind: r.kind as EnvKind, color: r.color as string,
  pollSeconds: Number(r.poll_seconds), rules: r.rules as string, exportDir: r.export_dir as string, createdAt: Number(r.created_at),
  ipRefreshMinutes: Number(r.ip_refresh_minutes ?? 5), conventionsPath: (r.conventions_path as string | null) ?? "",
});
const connFrom = (r: Row): ConnectionRow => ({
  id: r.id as string, envId: r.env_id as string, label: r.label as string, baseUrl: r.base_url as string,
  authKind: r.auth_kind as ConnectionRow["authKind"], username: r.username as string, tlsMode: r.tls_mode as ConnectionRow["tlsMode"],
  tlsFingerprint: r.tls_fingerprint as string, caPem: r.ca_pem as string, enabled: Number(r.enabled) === 1, webUrl: (r.web_url as string | null) ?? "",
});
const actFrom = (r: Row): ActivityRow => ({
  id: Number(r.id), envId: r.env_id as string, target: r.target as string, threadId: r.thread_id as string, turnId: r.turn_id as string,
  itemId: r.item_id as string, command: r.command as string, phase: r.phase as ActivityRow["phase"],
  exitCode: r.exit_code === null ? null : Number(r.exit_code), at: Number(r.at),
});
const changeFrom = (r: Row): ChangeRow => ({
  id: Number(r.id), envId: r.env_id as string, target: r.target as string, kind: r.kind as ChangeKind, detail: r.detail as string,
  threadId: (r.thread_id as string | null) ?? null, at: Number(r.at),
});

export class Store {
  private readonly db: SqlDb;
  private readonly now: () => number;

  constructor(db: SqlDb, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  listEnvs(): InfraEnvRow[] {
    return (this.db.prepare("SELECT * FROM infra_envs ORDER BY name COLLATE NOCASE").all() as Row[]).map(envFrom);
  }

  getEnv(id: string): InfraEnvRow | null {
    const r = this.db.prepare("SELECT * FROM infra_envs WHERE id = ?").get(id) as Row | undefined;
    return r ? envFrom(r) : null;
  }

  getEnvBySlug(slug: string): InfraEnvRow | null {
    const r = this.db.prepare("SELECT * FROM infra_envs WHERE slug = ?").get(slug) as Row | undefined;
    return r ? envFrom(r) : null;
  }

  upsertEnv(e: Omit<InfraEnvRow, "id" | "createdAt" | "ipRefreshMinutes" | "conventionsPath"> & { id?: string; ipRefreshMinutes?: number; conventionsPath?: string }): InfraEnvRow {
    if (!SLUG_RE.test(e.slug)) throw new Error(`slug must be 1-32 lowercase letters, digits, or dashes`);
    if (!(ENV_KINDS as readonly string[]).includes(e.kind)) throw new Error(`kind must be one of ${ENV_KINDS.join(", ")}`);
    if (!Number.isInteger(e.pollSeconds) || e.pollSeconds < 5 || e.pollSeconds > 300) throw new Error("poll interval must be 5-300 seconds");
    if (e.rules.length > RULES_MAX) throw new Error(`rules must be at most ${RULES_MAX} characters`);
    if (!e.name.trim()) throw new Error("name is required");
    const ipRefreshMinutes = e.ipRefreshMinutes ?? 5;
    if (!Number.isInteger(ipRefreshMinutes) || ipRefreshMinutes < 0 || ipRefreshMinutes > 1440) throw new Error("IP refresh must be 0 (off) to 1440 minutes");
    const conventionsPath = (e.conventionsPath ?? "").trim();
    if (conventionsPath && !conventionsPath.startsWith("/")) throw new Error("conventions file must be an absolute path on the BB server");
    const clash = this.getEnvBySlug(e.slug);
    if (clash && clash.id !== e.id) throw new Error(`slug "${e.slug}" is already used`);
    const existing = e.id ? this.getEnv(e.id) : null;
    const row: InfraEnvRow = {
      id: existing?.id ?? randomUUID(), slug: e.slug, name: e.name.trim(), kind: e.kind, color: e.color, pollSeconds: e.pollSeconds,
      rules: e.rules, exportDir: e.exportDir, createdAt: existing?.createdAt ?? this.now(), ipRefreshMinutes, conventionsPath,
    };
    this.db.prepare(`INSERT INTO infra_envs (id, slug, name, kind, color, poll_seconds, rules, export_dir, created_at, ip_refresh_minutes, conventions_path)
      VALUES (@id, @slug, @name, @kind, @color, @pollSeconds, @rules, @exportDir, @createdAt, @ipRefreshMinutes, @conventionsPath)
      ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, kind = excluded.kind, color = excluded.color,
        poll_seconds = excluded.poll_seconds, rules = excluded.rules, export_dir = excluded.export_dir,
        ip_refresh_minutes = excluded.ip_refresh_minutes, conventions_path = excluded.conventions_path`).run(row);
    return row;
  }

  deleteEnv(id: string): void {
    for (const table of ["connections", "activity", "changes"]) this.db.prepare(`DELETE FROM ${table} WHERE env_id = ?`).run(id);
    this.db.prepare("DELETE FROM infra_envs WHERE id = ?").run(id);
  }

  listConnections(envId?: string): ConnectionRow[] {
    const rows = envId
      ? this.db.prepare("SELECT * FROM connections WHERE env_id = ? ORDER BY label COLLATE NOCASE").all(envId)
      : this.db.prepare("SELECT * FROM connections ORDER BY label COLLATE NOCASE").all();
    return (rows as Row[]).map(connFrom);
  }

  getConnection(id: string): ConnectionRow | null {
    const r = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Row | undefined;
    return r ? connFrom(r) : null;
  }

  upsertConnection(c: Omit<ConnectionRow, "id" | "webUrl"> & { id?: string; webUrl?: string }): ConnectionRow {
    if (!this.getEnv(c.envId)) throw new Error("environment not found");
    const row: ConnectionRow = { ...c, webUrl: c.webUrl ?? "", id: c.id ?? randomUUID() };
    this.db.prepare(`INSERT INTO connections (id, env_id, label, base_url, auth_kind, username, tls_mode, tls_fingerprint, ca_pem, enabled, web_url)
      VALUES (@id, @envId, @label, @baseUrl, @authKind, @username, @tlsMode, @tlsFingerprint, @caPem, @enabled, @webUrl)
      ON CONFLICT(id) DO UPDATE SET env_id = excluded.env_id, label = excluded.label, base_url = excluded.base_url,
        auth_kind = excluded.auth_kind, username = excluded.username, tls_mode = excluded.tls_mode,
        tls_fingerprint = excluded.tls_fingerprint, ca_pem = excluded.ca_pem, enabled = excluded.enabled, web_url = excluded.web_url`)
      .run({ ...row, enabled: row.enabled ? 1 : 0 });
    return row;
  }

  deleteConnection(id: string): void {
    this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
  }

  addActivity(a: Omit<ActivityRow, "id">): void {
    this.db.prepare(`INSERT OR IGNORE INTO activity (env_id, target, thread_id, turn_id, item_id, command, phase, exit_code, at)
      VALUES (@envId, @target, @threadId, @turnId, @itemId, @command, @phase, @exitCode, @at)`).run(a);
  }

  activityFor(f: { envId?: string; targetPrefix?: string; threadId?: string; since?: number; limit: number }): ActivityRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: f.limit };
    if (f.envId) { where.push("env_id = @envId"); params.envId = f.envId; }
    if (f.targetPrefix) { where.push("(target = @prefix OR substr(target, 1, length(@prefix) + 1) = @prefix || '/')"); params.prefix = f.targetPrefix; }
    if (f.threadId) { where.push("thread_id = @threadId"); params.threadId = f.threadId; }
    if (f.since !== undefined) { where.push("at >= @since"); params.since = f.since; }
    const sql = `SELECT * FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY at DESC, id DESC LIMIT @limit`;
    return (this.db.prepare(sql).all(params) as Row[]).map(actFrom);
  }

  addChange(c: Omit<ChangeRow, "id">): ChangeRow {
    const r = this.db.prepare(`INSERT INTO changes (env_id, target, kind, detail, thread_id, at)
      VALUES (@envId, @target, @kind, @detail, @threadId, @at) RETURNING id`).get(c) as Row;
    return { ...c, id: Number(r.id) };
  }

  linkChange(id: number, threadId: string): void {
    this.db.prepare("UPDATE changes SET thread_id = ? WHERE id = ?").run(threadId, id);
  }

  changes(f: { envId?: string; since?: number; limit: number }): ChangeRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: f.limit };
    if (f.envId) { where.push("env_id = @envId"); params.envId = f.envId; }
    if (f.since !== undefined) { where.push("at >= @since"); params.since = f.since; }
    const sql = `SELECT * FROM changes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY at DESC, id DESC LIMIT @limit`;
    return (this.db.prepare(sql).all(params) as Row[]).map(changeFrom);
  }

  setPin(p: PinRow): void {
    this.db.prepare(`INSERT INTO scope_pins (thread_id, targets, rules_included, pinned_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET targets = excluded.targets, rules_included = excluded.rules_included, pinned_at = excluded.pinned_at`)
      .run(p.threadId, JSON.stringify(p.targets), p.rulesIncluded ? 1 : 0, p.pinnedAt);
  }

  deletePin(threadId: string): void {
    this.db.prepare("DELETE FROM scope_pins WHERE thread_id = ?").run(threadId);
  }

  listPins(): PinRow[] {
    return (this.db.prepare("SELECT * FROM scope_pins ORDER BY pinned_at").all() as Row[]).map((r) => ({
      threadId: r.thread_id as string, targets: JSON.parse(r.targets as string) as string[], rulesIncluded: Number(r.rules_included) === 1, pinnedAt: Number(r.pinned_at),
    }));
  }

  getCursor(threadId: string): number {
    const r = this.db.prepare("SELECT last_seq FROM cursors WHERE thread_id = ?").get(threadId) as Row | undefined;
    return r ? Number(r.last_seq) : 0;
  }

  setCursor(threadId: string, seq: number): void {
    this.db.prepare(`INSERT INTO cursors (thread_id, last_seq) VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET last_seq = excluded.last_seq`).run(threadId, seq);
  }

  prune(olderThan: number): void {
    this.db.prepare("DELETE FROM activity WHERE at < ?").run(olderThan);
    this.db.prepare("DELETE FROM changes WHERE at < ?").run(olderThan);
  }
}
