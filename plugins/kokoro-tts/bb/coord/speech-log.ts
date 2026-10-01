import type Database from "better-sqlite3";
import type { SpeechLogEntry } from "../schemas.ts";
import { normalizeLogText } from "./speakable.ts";

export type LogStatus = "queued" | "playing" | "done" | "interrupted" | "error" | "muted" | "empty";
export interface Limits { maxAgeDays: number; maxEntries: number }

/** Append-only: the host records each statement's hash by index. */
export const MIGRATIONS: string[] = [
  `CREATE TABLE speech_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  voice TEXT,
  engine TEXT,
  first_audio_ms INTEGER,
  error TEXT
);
CREATE INDEX speech_log_session ON speech_log(session_id, id);
CREATE INDEX speech_log_ts ON speech_log(ts);`,
];

/** Past a held reply's longest wait (15 min) and then some: older live rows are orphans. */
const STALE_SECONDS = 20 * 60;
const ERROR_MAX = 200;
const LATENCY_WINDOW = 50;

interface Row {
  id: number;
  ts: number;
  session_id: string;
  text: string;
  status: LogStatus;
  voice: string | null;
  engine: string | null;
  first_audio_ms: number | null;
  error: string | null;
}

function toEntry(row: Row): SpeechLogEntry {
  const e: SpeechLogEntry = { id: row.id, ts: row.ts, session_id: row.session_id, text: row.text, status: row.status };
  if (row.voice !== null) e.voice = row.voice;
  if (row.engine !== null) e.engine = row.engine;
  if (row.first_audio_ms !== null) e.first_audio_ms = row.first_audio_ms;
  if (row.error !== null) e.error = row.error;
  return e;
}

export class SpeechLogStore {
  #db: () => Database.Database;
  #migrate: (db: Database.Database, statements: string[]) => void;
  #limits: () => Limits;
  #now: () => number;

  constructor(deps: {
    db: () => Database.Database;
    migrate: (db: Database.Database, statements: string[]) => void;
    limits: () => Limits;
    now?: () => number;
  }) {
    this.#db = deps.db;
    this.#migrate = deps.migrate;
    this.#limits = deps.limits;
    this.#now = deps.now ?? Date.now;
  }

  /** Runs migrations, prunes to limits, reconciles stale rows. Call once at load, before anything speaks. */
  init(): void {
    this.#migrate(this.#db(), MIGRATIONS);
    this.prune();
    this.reconcile([]);
  }

  /** Inserts a row (status "queued", or the given terminal status) and enforces maxEntries in the same transaction. */
  add(text: string, sessionId: string, voice: string | null, status: LogStatus = "queued"): SpeechLogEntry {
    const db = this.#db();
    const insert = db.prepare("INSERT INTO speech_log (ts, session_id, text, status, voice) VALUES (?, ?, ?, ?, ?)");
    const cap = db.prepare("DELETE FROM speech_log WHERE id NOT IN (SELECT id FROM speech_log ORDER BY id DESC LIMIT ?)");
    const row: Row = {
      id: 0, ts: this.#now() / 1000, session_id: sessionId, text: normalizeLogText(text), status,
      voice, engine: null, first_audio_ms: null, error: null,
    };
    db.transaction(() => {
      row.id = Number(insert.run(row.ts, row.session_id, row.text, row.status, row.voice).lastInsertRowid);
      cap.run(this.#limits().maxEntries);
    })();
    return toEntry(row);
  }

  /** UPDATE only; a missing row is ignored. error is cut to 200 chars; first_audio_ms rounded. */
  setStatus(id: number, status: LogStatus, extra: { first_audio_ms?: number; error?: string; engine?: string } = {}): void {
    const ms = extra.first_audio_ms === undefined ? null : Math.round(extra.first_audio_ms);
    const error = extra.error === undefined ? null : Array.from(extra.error).slice(0, ERROR_MAX).join("");
    this.#db().prepare(
      `UPDATE speech_log SET status = ?, first_audio_ms = COALESCE(?, first_audio_ms),
         error = COALESCE(?, error), engine = COALESCE(?, engine) WHERE id = ?`,
    ).run(status, ms, error, extra.engine ?? null, id);
  }

  /** UPDATE only: records which engine produced the first audio. */
  setEngine(id: number, engine: string): void {
    this.#db().prepare("UPDATE speech_log SET engine = ? WHERE id = ?").run(engine, id);
  }

  /** The newest `limit` rows of one thread (default 50, clamped 1..500), oldest first. */
  list(sessionId: string, limit = 50): SpeechLogEntry[] {
    const n = Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.trunc(limit))) : 50;
    const rows = this.#db().prepare(
      "SELECT * FROM (SELECT * FROM speech_log WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
    ).all(sessionId, n) as Row[];
    return rows.map(toEntry);
  }

  deleteThread(sessionId: string): number {
    return this.#db().prepare("DELETE FROM speech_log WHERE session_id = ?").run(sessionId).changes;
  }

  clear(): number {
    return this.#db().prepare("DELETE FROM speech_log").run().changes;
  }

  /** Deletes rows older than maxAgeDays and beyond maxEntries (newest kept). Returns rows deleted. */
  prune(): number {
    const db = this.#db();
    const { maxAgeDays, maxEntries } = this.#limits();
    const byAge = db.prepare("DELETE FROM speech_log WHERE ts < ?");
    const byCount = db.prepare("DELETE FROM speech_log WHERE id NOT IN (SELECT id FROM speech_log ORDER BY id DESC LIMIT ?)");
    return db.transaction(() =>
      byAge.run(this.#now() / 1000 - maxAgeDays * 86_400).changes + byCount.run(maxEntries).changes
    )();
  }

  /**
   * queued/playing rows older than 20 minutes that no live reply owns become
   * interrupted (a reload or crash left them). `live`: the entry ids the hub
   * still holds or plays. Returns rows changed.
   */
  reconcile(live: Iterable<number>): number {
    return this.#db().prepare(
      `UPDATE speech_log SET status = 'interrupted' WHERE status IN ('queued', 'playing') AND ts < ?
         AND id NOT IN (SELECT value FROM json_each(?))`,
    ).run(this.#now() / 1000 - STALE_SECONDS, JSON.stringify([...live])).changes;
  }

  /** Median first_audio_ms over the last 50 done rows that have one. */
  latency(): { median_ms: number | null; samples: number } {
    const rows = this.#db().prepare(
      "SELECT first_audio_ms FROM speech_log WHERE status = 'done' AND first_audio_ms IS NOT NULL ORDER BY id DESC LIMIT ?",
    ).all(LATENCY_WINDOW) as { first_audio_ms: number }[];
    const ms = rows.map((r) => r.first_audio_ms).sort((a, b) => a - b);
    if (ms.length === 0) return { median_ms: null, samples: 0 };
    const mid = ms.length >> 1;
    const median = ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2);
    return { median_ms: median, samples: ms.length };
  }

  count(): number {
    return (this.#db().prepare("SELECT COUNT(*) AS n FROM speech_log").get() as { n: number }).n;
  }
}
