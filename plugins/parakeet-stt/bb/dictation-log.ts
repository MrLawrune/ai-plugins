// Dictation history in the plugin's SQLite data.db. Text only: audio is never stored.
import type Database from "better-sqlite3";
import type { HistoryEntry } from "./schemas.ts";

export type DictationSource = "oneshot" | "stream" | "voice";
export interface Limits { maxEntries: number; maxAgeDays: number }

/** Append-only: the host records each statement's hash by index. */
export const MIGRATIONS: string[] = [`CREATE TABLE dictation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  device_id TEXT
);
CREATE INDEX dictation_log_ts ON dictation_log(ts);`];

const TEXT_MAX = 4000;
const LIST_DEFAULT = 200;
const DAY_MS = 86_400_000;

const NEWEST_FIRST = "ORDER BY ts DESC, id DESC";
const CAP_SQL = `DELETE FROM dictation_log WHERE id NOT IN (SELECT id FROM dictation_log ${NEWEST_FIRST} LIMIT ?)`;

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));
/** Cuts to TEXT_MAX code points so a surrogate pair is never split. */
const truncate = (text: string) => (text.length <= TEXT_MAX ? text : Array.from(text).slice(0, TEXT_MAX).join(""));

interface Row { id: number; ts: number; text: string; duration_ms: number; source: DictationSource }

export class DictationLog {
  #db: () => Database.Database;
  #migrate: (db: Database.Database, statements: string[]) => void;
  #limits: () => Limits;
  #now: () => number;
  #warn: (msg: string) => void;
  #recording: () => boolean;
  /** Why history is unavailable (a failed init), or null. */
  #unavailable: string | null = "not initialised";

  constructor(deps: {
    db: () => Database.Database;
    migrate: (db: Database.Database, statements: string[]) => void;
    limits: () => Limits;
    now: () => number;
    /** History is best-effort: add/prune report a database error here instead of throwing. */
    warn?: (msg: string) => void;
    /** `add` records nothing while this is false (the stored retention settings are not known). */
    recording?: () => boolean;
  }) {
    this.#db = deps.db;
    this.#migrate = deps.migrate;
    this.#limits = deps.limits;
    this.#now = deps.now;
    this.#warn = deps.warn ?? (() => {});
    this.#recording = deps.recording ?? (() => true);
  }

  /**
   * Runs migrations and prunes to the current limits. Call once at load. Best-effort: a failure is
   * reported and leaves history unavailable for this load (false); a later call retries.
   */
  init(): boolean {
    try {
      this.#migrate(this.#db(), MIGRATIONS);
      this.#unavailable = null;
    } catch (err) {
      this.#unavailable = errorText(err);
      this.#warn(`dictation history is unavailable until the next load: ${this.#unavailable}`);
      return false;
    }
    this.prune();
    return true;
  }

  #require(): void {
    if (this.#unavailable !== null) throw new Error(`Dictation history is unavailable: ${this.#unavailable}`);
  }

  /** Blank text and maxEntries 0 record nothing. Inserts and enforces maxEntries in one transaction. */
  add(e: { text: string; durationMs: number; source: DictationSource; deviceId: string | null }): void {
    if (this.#unavailable !== null || !this.#recording()) return;
    try {
      this.#insert([{ ...e, ts: this.#now() }]);
    } catch (err) {
      this.#warn(`dictation history write failed: ${errorText(err)}`);
    }
  }

  /** Newest first (by time, then insertion). */
  list(limit = LIST_DEFAULT): HistoryEntry[] {
    this.#require();
    const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : LIST_DEFAULT;
    const rows = this.#db().prepare(`SELECT id, ts, text, duration_ms, source FROM dictation_log ${NEWEST_FIRST} LIMIT ?`).all(n) as Row[];
    return rows.map((r) => ({ id: r.id, text: r.text, at: r.ts, durationMs: r.duration_ms, source: r.source }));
  }

  clear(): void {
    this.#require();
    this.#db().prepare("DELETE FROM dictation_log").run();
  }

  /** Deletes rows older than maxAgeDays, then everything beyond the newest maxEntries. A database error is reported, not thrown. */
  prune(): void {
    if (this.#unavailable !== null) return;
    try {
      const db = this.#db();
      const { maxAgeDays, maxEntries } = this.#limits();
      const byAge = db.prepare("DELETE FROM dictation_log WHERE ts < ?");
      const byCount = db.prepare(CAP_SQL);
      db.transaction(() => {
        byAge.run(this.#now() - maxAgeDays * DAY_MS);
        byCount.run(Math.max(0, maxEntries));
      })();
    } catch (err) {
      this.#warn(`dictation history prune failed: ${errorText(err)}`);
    }
  }

  /** One-time import of the old kv history (newest first), stored as "oneshot" at their own times. */
  importLegacy(entries: { text: string; at: number; durationMs: number }[]): void {
    if (entries.length) this.#require();
    this.#insert(
      [...entries].reverse().map((e) => ({ text: e.text, durationMs: e.durationMs, source: "oneshot" as const, deviceId: null, ts: e.at })),
    );
    this.prune();
  }

  #insert(rows: { text: string; durationMs: number; source: DictationSource; deviceId: string | null; ts: number }[]): void {
    const { maxEntries } = this.#limits();
    const kept = rows.filter((r) => r.text.trim() !== "");
    if (maxEntries <= 0 || kept.length === 0) return;
    const db = this.#db();
    const insert = db.prepare("INSERT INTO dictation_log (ts, text, duration_ms, source, device_id) VALUES (?, ?, ?, ?, ?)");
    const cap = db.prepare(CAP_SQL);
    db.transaction(() => {
      for (const r of kept) insert.run(r.ts, truncate(r.text), Math.round(r.durationMs), r.source, r.deviceId);
      cap.run(maxEntries);
    })();
  }
}
