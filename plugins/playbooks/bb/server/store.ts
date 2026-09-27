// Plugin-owned SQLite state: environments, inventories, credential references, runs, run events, investigations, thread files.
import { randomUUID } from "node:crypto";
import { ENV_KINDS, LIMITS, RULES_MAX, type EnvKind } from "../shared/constants.ts";
import type { HostStats, RunEvent, RunSpec, RunStatus } from "../shared/types.ts";

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
  `CREATE TABLE playbooks_envs (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL, color TEXT NOT NULL, rules TEXT NOT NULL, control_host TEXT NOT NULL, host_id TEXT, repo_path TEXT NOT NULL, inventory_root TEXT NOT NULL, runner_kind TEXT NOT NULL, agent_approval TEXT NOT NULL, default_check INTEGER NOT NULL, infra_env_slug TEXT, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE inventories (id TEXT PRIMARY KEY, env_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, default_limit TEXT, discovered INTEGER NOT NULL, resolved_at INTEGER, groups TEXT, UNIQUE (env_id, path))`,
  `CREATE TABLE credrefs (id TEXT PRIMARY KEY, env_id TEXT NOT NULL, name TEXT NOT NULL, ssh_user TEXT, key_path TEXT, become_method TEXT, vault_password_file TEXT, ansible_cfg TEXT)`,
  `CREATE TABLE runs (id TEXT PRIMARY KEY, env_id TEXT NOT NULL, runner_kind TEXT NOT NULL, playbook TEXT NOT NULL, playbook_name TEXT NOT NULL, playbook_hash TEXT, template_id TEXT, spec TEXT NOT NULL, status TEXT NOT NULL, external_id TEXT, external_url TEXT, source_surface TEXT NOT NULL, source_thread_id TEXT, source_schedule_id TEXT, approval TEXT NOT NULL, requested_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, recap TEXT, error TEXT, last_line TEXT, log_path TEXT)`,
  `CREATE INDEX runs_status ON runs (status)`,
  `CREATE INDEX runs_requested ON runs (requested_at)`,
  `CREATE INDEX runs_env_playbook ON runs (env_id, playbook, requested_at)`,
  `CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, play TEXT, task TEXT, task_action TEXT, node_id TEXT, host TEXT, changed INTEGER NOT NULL, failed INTEGER NOT NULL, msg TEXT, res TEXT, diff TEXT, stdout TEXT, source TEXT NOT NULL, PRIMARY KEY (run_id, seq))`,
  `CREATE TABLE investigations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE, host TEXT, node_id TEXT, scope TEXT NOT NULL, status TEXT NOT NULL, summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX investigations_run ON investigations (run_id)`,
  `CREATE TABLE thread_files (thread_id TEXT NOT NULL, env_id TEXT NOT NULL, path TEXT NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (thread_id, env_id, path))`,
  `CREATE TABLE cursors (thread_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)`,
  `ALTER TABLE investigations ADD COLUMN permission_mode TEXT`,
];

export interface PlaybooksEnvRow {
  id: string; slug: string; name: string; kind: EnvKind; color: string; rules: string; controlHost: string; hostId: string | null;
  repoPath: string; inventoryRoot: string; runnerKind: string; agentApproval: string; defaultCheck: boolean; infraEnvSlug: string | null;
  enabled: boolean; createdAt: number;
}
export interface InventoryRow { id: string; envId: string; name: string; kind: string; path: string; defaultLimit: string | null; discovered: boolean; resolvedAt: number | null; groups: string | null }
export interface CredRefRow { id: string; envId: string; name: string; sshUser: string | null; keyPath: string | null; becomeMethod: string | null; vaultPasswordFile: string | null; ansibleCfg: string | null }
export interface RunSourceRow { surface: string; threadId: string | null; scheduleId: string | null }
export interface RunRow {
  id: string; envId: string; runnerKind: string; playbook: string; playbookName: string; playbookHash: string | null; templateId: string | null;
  spec: RunSpec; status: RunStatus; externalId: string | null; externalUrl: string | null; source: RunSourceRow; approval: string;
  requestedAt: number; startedAt: number | null; endedAt: number | null; recap: Record<string, HostStats> | null;
  error: string | null; lastLine: string | null; logPath: string | null;
}
export type RunEventRow = RunEvent & { runId: string; seq: number };
export interface InvestigationRow {
  id: string; runId: string; threadId: string; host: string | null; nodeId: string | null; scope: string; status: string; summary: string | null;
  /** Effective mode the thread was spawned with (`readonly`, or `accept-edits` when the host refused readonly); null for rows before the column existed. */
  permissionMode: string | null;
  createdAt: number; updatedAt: number;
}
export interface ThreadFileRow { threadId: string; envId: string; path: string; lastSeenAt: number }

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : (v as string));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const clip = (v: string | null, max: number): string | null => (v === null ? null : v.slice(0, max));

const envFrom = (r: Row): PlaybooksEnvRow => ({
  id: r.id as string, slug: r.slug as string, name: r.name as string, kind: r.kind as EnvKind, color: r.color as string, rules: r.rules as string,
  controlHost: r.control_host as string, hostId: str(r.host_id), repoPath: r.repo_path as string, inventoryRoot: r.inventory_root as string,
  runnerKind: r.runner_kind as string, agentApproval: r.agent_approval as string, defaultCheck: Number(r.default_check) === 1,
  infraEnvSlug: str(r.infra_env_slug), enabled: Number(r.enabled) === 1, createdAt: Number(r.created_at),
});
const inventoryFrom = (r: Row): InventoryRow => ({
  id: r.id as string, envId: r.env_id as string, name: r.name as string, kind: r.kind as string, path: r.path as string,
  defaultLimit: str(r.default_limit), discovered: Number(r.discovered) === 1, resolvedAt: num(r.resolved_at), groups: str(r.groups),
});
const credFrom = (r: Row): CredRefRow => ({
  id: r.id as string, envId: r.env_id as string, name: r.name as string, sshUser: str(r.ssh_user), keyPath: str(r.key_path),
  becomeMethod: str(r.become_method), vaultPasswordFile: str(r.vault_password_file), ansibleCfg: str(r.ansible_cfg),
});
const runFrom = (r: Row): RunRow => ({
  id: r.id as string, envId: r.env_id as string, runnerKind: r.runner_kind as string, playbook: r.playbook as string,
  playbookName: r.playbook_name as string, playbookHash: str(r.playbook_hash), templateId: str(r.template_id),
  spec: JSON.parse(r.spec as string) as RunSpec, status: r.status as RunStatus, externalId: str(r.external_id), externalUrl: str(r.external_url),
  source: { surface: r.source_surface as string, threadId: str(r.source_thread_id), scheduleId: str(r.source_schedule_id) },
  approval: r.approval as string, requestedAt: Number(r.requested_at), startedAt: num(r.started_at), endedAt: num(r.ended_at),
  recap: r.recap === null || r.recap === undefined ? null : (JSON.parse(r.recap as string) as Record<string, HostStats>),
  error: str(r.error), lastLine: str(r.last_line), logPath: str(r.log_path),
});
const eventFrom = (r: Row): RunEventRow => ({
  runId: r.run_id as string, seq: Number(r.seq), at: Number(r.at), kind: r.kind as RunEvent["kind"], play: str(r.play), task: str(r.task),
  taskAction: str(r.task_action), nodeId: str(r.node_id), host: str(r.host), changed: Number(r.changed) === 1, failed: Number(r.failed) === 1,
  msg: str(r.msg), res: str(r.res), diff: str(r.diff), stdout: str(r.stdout), source: r.source as RunEvent["source"],
});
const investigationFrom = (r: Row): InvestigationRow => ({
  id: r.id as string, runId: r.run_id as string, threadId: r.thread_id as string, host: str(r.host), nodeId: str(r.node_id),
  scope: r.scope as string, status: r.status as string, summary: str(r.summary), permissionMode: str(r.permission_mode), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});
const fileFrom = (r: Row): ThreadFileRow => ({ threadId: r.thread_id as string, envId: r.env_id as string, path: r.path as string, lastSeenAt: Number(r.last_seen_at) });

export type EnvInput = Omit<PlaybooksEnvRow, "id" | "createdAt"> & { id?: string | undefined };
export type RunInsert = Pick<RunRow, "envId" | "runnerKind" | "playbook" | "playbookName" | "playbookHash" | "templateId" | "spec" | "source" | "approval">;
export type RunPatch = Partial<Pick<RunRow, "status" | "externalId" | "externalUrl" | "startedAt" | "endedAt" | "recap" | "error" | "lastLine" | "logPath">>;
export type InvestigationPatch = Partial<Pick<InvestigationRow, "status" | "summary">>;

const RUN_COLUMNS: Record<keyof RunPatch, string> = {
  status: "status", externalId: "external_id", externalUrl: "external_url", startedAt: "started_at", endedAt: "ended_at",
  recap: "recap", error: "error", lastLine: "last_line", logPath: "log_path",
};

export class Store {
  private readonly db: SqlDb;
  private readonly now: () => number;

  constructor(db: SqlDb, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  listEnvs(): PlaybooksEnvRow[] {
    return (this.db.prepare("SELECT * FROM playbooks_envs ORDER BY name COLLATE NOCASE").all() as Row[]).map(envFrom);
  }

  getEnv(id: string): PlaybooksEnvRow | null {
    const r = this.db.prepare("SELECT * FROM playbooks_envs WHERE id = ?").get(id) as Row | undefined;
    return r ? envFrom(r) : null;
  }

  getEnvBySlug(slug: string): PlaybooksEnvRow | null {
    const r = this.db.prepare("SELECT * FROM playbooks_envs WHERE slug = ?").get(slug) as Row | undefined;
    return r ? envFrom(r) : null;
  }

  upsertEnv(e: EnvInput): PlaybooksEnvRow {
    if (!(ENV_KINDS as readonly string[]).includes(e.kind)) throw new Error(`kind must be one of ${ENV_KINDS.join(", ")}`);
    if (e.rules.length > RULES_MAX) throw new Error(`rules must be at most ${RULES_MAX} characters`);
    if (!e.name.trim()) throw new Error("name is required");
    const clash = this.getEnvBySlug(e.slug);
    if (clash && clash.id !== e.id) throw new Error("slug already used");
    const existing = e.id ? this.getEnv(e.id) : null;
    const row: PlaybooksEnvRow = {
      id: existing?.id ?? randomUUID(), slug: e.slug, name: e.name.trim(), kind: e.kind, color: e.color, rules: e.rules,
      controlHost: e.controlHost, hostId: e.hostId, repoPath: e.repoPath, inventoryRoot: e.inventoryRoot, runnerKind: e.runnerKind,
      agentApproval: e.agentApproval, defaultCheck: e.defaultCheck, infraEnvSlug: e.infraEnvSlug, enabled: e.enabled,
      createdAt: existing?.createdAt ?? this.now(),
    };
    this.db.prepare(`INSERT INTO playbooks_envs (id, slug, name, kind, color, rules, control_host, host_id, repo_path, inventory_root, runner_kind, agent_approval, default_check, infra_env_slug, enabled, created_at)
      VALUES (@id, @slug, @name, @kind, @color, @rules, @controlHost, @hostId, @repoPath, @inventoryRoot, @runnerKind, @agentApproval, @defaultCheck, @infraEnvSlug, @enabled, @createdAt)
      ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, kind = excluded.kind, color = excluded.color, rules = excluded.rules,
        control_host = excluded.control_host, host_id = excluded.host_id, repo_path = excluded.repo_path, inventory_root = excluded.inventory_root,
        runner_kind = excluded.runner_kind, agent_approval = excluded.agent_approval, default_check = excluded.default_check,
        infra_env_slug = excluded.infra_env_slug, enabled = excluded.enabled`)
      .run({ ...row, defaultCheck: row.defaultCheck ? 1 : 0, enabled: row.enabled ? 1 : 0 });
    return row;
  }

  deleteEnv(id: string): void {
    for (const table of ["inventories", "credrefs", "thread_files"]) this.db.prepare(`DELETE FROM ${table} WHERE env_id = ?`).run(id);
    this.db.prepare("DELETE FROM playbooks_envs WHERE id = ?").run(id);
  }

  /** Swap the discovered inventory set for an env; manually added inventories are kept. */
  replaceDiscoveredInventories(envId: string, refs: { name: string; kind: string; path: string; defaultLimit?: string | null }[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM inventories WHERE env_id = ? AND discovered = 1").run(envId);
      for (const r of refs) {
        this.db.prepare(`INSERT INTO inventories (id, env_id, name, kind, path, default_limit, discovered, resolved_at, groups)
          VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL) ON CONFLICT(env_id, path) DO NOTHING`)
          .run(randomUUID(), envId, r.name, r.kind, r.path, r.defaultLimit ?? null);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  upsertInventory(i: Omit<InventoryRow, "id" | "resolvedAt" | "groups"> & { id?: string }): InventoryRow {
    const existing = this.db.prepare("SELECT * FROM inventories WHERE id = ? OR (env_id = ? AND path = ?)").get(i.id ?? "", i.envId, i.path) as Row | undefined;
    const id = existing ? (existing.id as string) : (i.id ?? randomUUID());
    this.db.prepare(`INSERT INTO inventories (id, env_id, name, kind, path, default_limit, discovered, resolved_at, groups)
      VALUES (@id, @envId, @name, @kind, @path, @defaultLimit, @discovered, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET env_id = excluded.env_id, name = excluded.name, kind = excluded.kind, path = excluded.path,
        default_limit = excluded.default_limit, discovered = excluded.discovered`)
      .run({ id, envId: i.envId, name: i.name, kind: i.kind, path: i.path, defaultLimit: i.defaultLimit, discovered: i.discovered ? 1 : 0 });
    return inventoryFrom(this.db.prepare("SELECT * FROM inventories WHERE id = ?").get(id) as Row);
  }

  listInventories(envId: string): InventoryRow[] {
    return (this.db.prepare("SELECT * FROM inventories WHERE env_id = ? ORDER BY path").all(envId) as Row[]).map(inventoryFrom);
  }

  setInventoryGroups(id: string, groupsJson: string): void {
    this.db.prepare("UPDATE inventories SET groups = ?, resolved_at = ? WHERE id = ?").run(groupsJson, this.now(), id);
  }

  upsertCredRef(c: Omit<CredRefRow, "id"> & { id?: string }): CredRefRow {
    const row: CredRefRow = { ...c, id: c.id ?? randomUUID() };
    this.db.prepare(`INSERT INTO credrefs (id, env_id, name, ssh_user, key_path, become_method, vault_password_file, ansible_cfg)
      VALUES (@id, @envId, @name, @sshUser, @keyPath, @becomeMethod, @vaultPasswordFile, @ansibleCfg)
      ON CONFLICT(id) DO UPDATE SET env_id = excluded.env_id, name = excluded.name, ssh_user = excluded.ssh_user, key_path = excluded.key_path,
        become_method = excluded.become_method, vault_password_file = excluded.vault_password_file, ansible_cfg = excluded.ansible_cfg`).run(row);
    return row;
  }

  listCredRefs(envId: string): CredRefRow[] {
    return (this.db.prepare("SELECT * FROM credrefs WHERE env_id = ? ORDER BY name COLLATE NOCASE").all(envId) as Row[]).map(credFrom);
  }

  deleteCredRef(id: string): void {
    this.db.prepare("DELETE FROM credrefs WHERE id = ?").run(id);
  }

  insertRun(r: RunInsert): RunRow {
    const row: RunRow = {
      ...r, id: `run_${randomUUID().replace(/-/g, "").slice(0, 20)}`, status: "queued", externalId: null, externalUrl: null,
      requestedAt: this.now(), startedAt: null, endedAt: null, recap: null, error: null, lastLine: null, logPath: null,
    };
    this.db.prepare(`INSERT INTO runs (id, env_id, runner_kind, playbook, playbook_name, playbook_hash, template_id, spec, status, source_surface, source_thread_id, source_schedule_id, approval, requested_at)
      VALUES (@id, @envId, @runnerKind, @playbook, @playbookName, @playbookHash, @templateId, @spec, @status, @surface, @threadId, @scheduleId, @approval, @requestedAt)`)
      .run({
        id: row.id, envId: row.envId, runnerKind: row.runnerKind, playbook: row.playbook, playbookName: row.playbookName, playbookHash: row.playbookHash,
        templateId: row.templateId, spec: JSON.stringify(row.spec), status: row.status, surface: row.source.surface, threadId: row.source.threadId,
        scheduleId: row.source.scheduleId, approval: row.approval, requestedAt: row.requestedAt,
      });
    return row;
  }

  updateRun(id: string, patch: RunPatch): RunRow | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(RUN_COLUMNS) as (keyof RunPatch)[]) {
      if (!(key in patch) || patch[key] === undefined) continue;
      let v: unknown = patch[key];
      if (key === "error") v = clip(v as string | null, LIMITS.error);
      else if (key === "lastLine") v = clip(v as string | null, LIMITS.lastLine);
      else if (key === "recap") v = v === null ? null : JSON.stringify(v);
      sets.push(`${RUN_COLUMNS[key]} = ?`);
      params.push(v);
    }
    if (sets.length) this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    return this.getRun(id);
  }

  getRun(id: string): RunRow | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return r ? runFrom(r) : null;
  }

  listRuns(f: { envId?: string; playbook?: string; status?: RunStatus; threadId?: string; limit: number }): RunRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: f.limit };
    if (f.envId) { where.push("env_id = @envId"); params.envId = f.envId; }
    if (f.playbook) { where.push("playbook = @playbook"); params.playbook = f.playbook; }
    if (f.status) { where.push("status = @status"); params.status = f.status; }
    if (f.threadId) { where.push("source_thread_id = @threadId"); params.threadId = f.threadId; }
    const sql = `SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY requested_at DESC, rowid DESC LIMIT @limit`;
    return (this.db.prepare(sql).all(params) as Row[]).map(runFrom);
  }

  listOpenRuns(): RunRow[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status IN ('queued', 'starting', 'running') ORDER BY requested_at").all() as Row[]).map(runFrom);
  }

  /** The newest event of one kind (e.g. the final `stats`), or null. */
  lastEventOfKind(runId: string, kind: RunEvent["kind"]): RunEventRow | null {
    const r = this.db.prepare("SELECT * FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1").get(runId, kind) as Row | undefined;
    return r ? eventFrom(r) : null;
  }

  lastEventSeq(runId: string): number {
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM run_events WHERE run_id = ?").get(runId) as Row | undefined;
    return r && r.m !== null && r.m !== undefined ? Number(r.m) : 0;
  }

  /** Append events in one transaction, numbering from the current tail; returns the next free seq. */
  appendEvents(runId: string, events: Omit<RunEvent, "seq">[]): number {
    let seq = this.lastEventSeq(runId);
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(`INSERT INTO run_events (run_id, seq, at, kind, play, task, task_action, node_id, host, changed, failed, msg, res, diff, stdout, source)
        VALUES (@runId, @seq, @at, @kind, @play, @task, @taskAction, @nodeId, @host, @changed, @failed, @msg, @res, @diff, @stdout, @source)`);
      for (const e of events) {
        seq += 1;
        stmt.run({
          runId, seq, at: e.at, kind: e.kind, play: e.play, task: e.task, taskAction: e.taskAction, nodeId: e.nodeId, host: e.host,
          changed: e.changed ? 1 : 0, failed: e.failed ? 1 : 0, msg: clip(e.msg, LIMITS.msg), res: clip(e.res, LIMITS.res),
          diff: clip(e.diff, LIMITS.diff), stdout: clip(e.stdout, LIMITS.stdout), source: e.source,
        });
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return seq + 1;
  }

  /**
   * Every event of a run without its heavy columns (msg, res, diff, stdout are null, except the `res` of `stats`
   * rows, which the recap is read from). Enough to build the matrix; the full rows stay behind `listEvents`.
   */
  listEventsLight(runId: string): RunEventRow[] {
    const cols = "run_id, seq, at, kind, play, task, task_action, node_id, host, changed, failed, NULL AS msg, CASE WHEN kind = 'stats' THEN res ELSE NULL END AS res, NULL AS diff, NULL AS stdout, source";
    return (this.db.prepare(`SELECT ${cols} FROM run_events WHERE run_id = ? ORDER BY seq`).all(runId) as Row[]).map(eventFrom);
  }

  listEvents(runId: string, f: { cursor: number; limit: number; host?: string; node?: string; failedOnly?: boolean }): RunEventRow[] {
    const where = ["run_id = @runId", "seq > @cursor"];
    const params: Record<string, unknown> = { runId, cursor: f.cursor, limit: f.limit };
    if (f.host) { where.push("host = @host"); params.host = f.host; }
    if (f.node) { where.push("node_id = @node"); params.node = f.node; }
    if (f.failedOnly) where.push("(failed = 1 OR kind IN ('host_unreachable', 'error'))");
    return (this.db.prepare(`SELECT * FROM run_events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT @limit`).all(params) as Row[]).map(eventFrom);
  }

  insertInvestigation(i: { runId: string; threadId: string; host: string | null; nodeId: string | null; scope: string; permissionMode: string | null }): InvestigationRow {
    const at = this.now();
    const row: InvestigationRow = { ...i, id: randomUUID(), status: "running", summary: null, createdAt: at, updatedAt: at };
    this.db.prepare(`INSERT INTO investigations (id, run_id, thread_id, host, node_id, scope, status, summary, permission_mode, created_at, updated_at)
      VALUES (@id, @runId, @threadId, @host, @nodeId, @scope, @status, @summary, @permissionMode, @createdAt, @updatedAt)`).run(row);
    return row;
  }

  updateInvestigation(id: string, patch: InvestigationPatch): void {
    const cur = this.db.prepare("SELECT * FROM investigations WHERE id = ?").get(id) as Row | undefined;
    if (!cur) return;
    const status = patch.status ?? (cur.status as string);
    const summary = patch.summary === undefined ? str(cur.summary) : patch.summary;
    this.db.prepare("UPDATE investigations SET status = ?, summary = ?, updated_at = ? WHERE id = ?").run(status, summary, this.now(), id);
  }

  listInvestigations(runId: string): InvestigationRow[] {
    return (this.db.prepare("SELECT * FROM investigations WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as Row[]).map(investigationFrom);
  }

  investigationByThread(threadId: string): InvestigationRow | null {
    const r = this.db.prepare("SELECT * FROM investigations WHERE thread_id = ?").get(threadId) as Row | undefined;
    return r ? investigationFrom(r) : null;
  }

  touchThreadFile(threadId: string, envId: string, path: string): void {
    this.db.prepare(`INSERT INTO thread_files (thread_id, env_id, path, last_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id, env_id, path) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(threadId, envId, path, this.now());
  }

  threadFiles(threadId: string): ThreadFileRow[] {
    return (this.db.prepare("SELECT * FROM thread_files WHERE thread_id = ? ORDER BY last_seen_at DESC, path").all(threadId) as Row[]).map(fileFrom);
  }

  filesByEnv(envId: string): ThreadFileRow[] {
    return (this.db.prepare("SELECT * FROM thread_files WHERE env_id = ? ORDER BY last_seen_at DESC, path").all(envId) as Row[]).map(fileFrom);
  }

  /** Drop runs requested before the cutoff along with their events and investigations. */
  prune(beforeMs: number): void {
    const old = "(SELECT id FROM runs WHERE requested_at < ?)";
    this.db.prepare(`DELETE FROM run_events WHERE run_id IN ${old}`).run(beforeMs);
    this.db.prepare(`DELETE FROM investigations WHERE run_id IN ${old}`).run(beforeMs);
    this.db.prepare("DELETE FROM runs WHERE requested_at < ?").run(beforeMs);
  }
}
