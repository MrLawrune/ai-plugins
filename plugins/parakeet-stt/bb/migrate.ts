// One-shot migration of the 0.1.0 storage (kv `profiles-v1`, legacy `prefs`, `history`) into the
// `settings` row and the dictation log. Never throws: on any failure the old rows stay and the
// plugin loads with defaults.
import { z } from "zod";
import type { DictationLog } from "./dictation-log.ts";
import {
  DEFAULT_PREFS,
  freshState,
  isRecord,
  KIND_PROFILE_NAMES,
  parsePrefs,
  parseRows,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  type State,
} from "./prefs.ts";
import { prefsSchema, type Prefs } from "./schemas.ts";

export const MIGRATION_NOTE_KEY = "migration-note";
export const MIGRATION_NOTE = "Settings moved to the new layout. History now keeps 7 days.";
export const MIGRATION_NOTE_FAILED_IMPORT = `${MIGRATION_NOTE} Your earlier dictation history could not be imported yet; bb will retry.`;
/** Set when the history import failed; the old `history` row is kept and the import retried on each load. */
export const HISTORY_PENDING_KEY = "history-import-pending";

const OLD_STATE_KEY = "profiles-v1";
const OLD_PREFS_KEY = "prefs";
const OLD_HISTORY_KEY = "history";

/** `recovered`: the validated 0.1.0 state when the `settings` write failed; the store serves it from memory. */
export interface MigrateResult {
  migrated: boolean;
  note: string | null;
  recovered?: State;
  /** With `recovered`: deletes the legacy rows (best-effort); the store runs it after its first successful write. */
  cleanup?: () => Promise<void>;
}

interface MigrateKv {
  get<T>(k: string): Promise<T | undefined>;
  set(k: string, v: unknown): Promise<void>;
  delete(k: string): Promise<void>;
}
type Deps = { kv: MigrateKv; log: Pick<DictationLog, "importLegacy">; warn: (m: string) => void };
type OldEntry = { text: string; at: number; durationMs: number };

/** 0.1.0 kept the newest `historyLimit` (0–50) entries; its default was 5. */
const historyLimitSchema = z.number().int().min(0).max(50);
const legacyEntrySchema = z.object({ text: z.string(), at: z.number().finite(), durationMs: z.number().finite() });

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

/** 0.1.0 prefs: `historyLimit` is the entry limit and the retention age is the new default. */
function parseLegacyPrefs(raw: unknown): Prefs {
  const src = isRecord(raw) ? raw : {};
  const limit = historyLimitSchema.safeParse(src.historyLimit);
  return { ...parsePrefs(limit.success ? { ...src, historyMaxEntries: limit.data } : src), historyMaxAgeDays: DEFAULT_PREFS.historyMaxAgeDays };
}

/** The 0.1.0 `profiles-v1` row as the new state, or null when it holds no usable profile. */
function parseOldState(raw: unknown): State | null {
  const state = isRecord(raw) ? parseRows(raw, parseLegacyPrefs) : null;
  if (!state) return null;
  const { profiles, devices } = state;
  // The earlier Phone profile is the touch-screen profile.
  if (profiles.phone && !profiles.touch) {
    profiles.touch = { ...profiles.phone, name: profiles.phone.name === "Phone" ? KIND_PROFILE_NAMES.touch : profiles.phone.name };
    delete profiles.phone;
    for (const d of Object.values(devices)) if (d.profileId === "phone") d.profileId = "touch";
  }
  return state;
}

/** Old history entries (newest first), skipping malformed ones, at most `limit`. */
function parseOldHistory(raw: unknown, limit: number): OldEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: OldEntry[] = [];
  for (const item of raw) {
    const parsed = legacyEntrySchema.safeParse(item);
    if (parsed.success) entries.push({ text: parsed.data.text, at: parsed.data.at, durationMs: parsed.data.durationMs });
  }
  return entries.slice(0, limit);
}

/** Import the old history, then drop its row. False (warned, nothing deleted) when the import throws. */
async function importHistory(d: Deps, entries: OldEntry[]): Promise<boolean> {
  try {
    d.log.importLegacy(entries);
  } catch (e) {
    d.warn(`dictation history import failed: ${errorText(e)}`);
    return false;
  }
  await deleteRow(d, OLD_HISTORY_KEY);
  return true;
}

async function deleteRow(d: Deps, key: string): Promise<void> {
  try {
    await d.kv.delete(key);
  } catch (e) {
    d.warn(`could not delete the old ${key} row: ${errorText(e)}`);
  }
}

/** Retry an earlier failed history import under the history limit stored in `settings`; its success replaces the failure note. */
async function retryHistory(d: Deps, settings: unknown): Promise<void> {
  const history = await d.kv.get<unknown>(OLD_HISTORY_KEY);
  if (history === undefined) return void (await deleteRow(d, HISTORY_PENDING_KEY));
  const stored = isRecord(settings) && isRecord(settings.shared) ? prefsSchema.shape.historyMaxEntries.safeParse(settings.shared.historyMaxEntries) : null;
  if (await importHistory(d, parseOldHistory(history, stored?.success ? stored.data : DEFAULT_PREFS.historyMaxEntries))) {
    await deleteRow(d, HISTORY_PENDING_KEY);
    // A dismissed note stays dismissed: only a note still showing the failure is replaced.
    if ((await d.kv.get<unknown>(MIGRATION_NOTE_KEY)) === MIGRATION_NOTE_FAILED_IMPORT) await setNote(d, MIGRATION_NOTE);
  }
}

async function setNote(d: Deps, note: string): Promise<void> {
  try {
    await d.kv.set(MIGRATION_NOTE_KEY, note);
  } catch (e) {
    d.warn(`could not store the migration note: ${errorText(e)}`);
  }
}

/**
 * Builds the `settings` row from the 0.1.0 rows when it does not exist yet, imports the old history
 * into the dictation log and deletes the old rows. The `settings` write comes first so a failure
 * before it leaves everything as it was; the history import follows it and is best-effort: when it
 * fails the old `history` row stays, a marker is set and the import is retried on each later load.
 */
export async function migrate(d: Deps): Promise<MigrateResult> {
  let state: State;
  let rawHistory: unknown;
  const present: string[] = [];
  try {
    const settings = await d.kv.get<unknown>(SETTINGS_KEY);
    if (settings !== undefined) {
      if ((await d.kv.get<unknown>(HISTORY_PENDING_KEY)) !== undefined) await retryHistory(d, settings);
      return { migrated: false, note: null };
    }
    const oldState = await d.kv.get<unknown>(OLD_STATE_KEY);
    const oldPrefs = await d.kv.get<unknown>(OLD_PREFS_KEY);
    rawHistory = await d.kv.get<unknown>(OLD_HISTORY_KEY);
    for (const [key, value] of [[OLD_STATE_KEY, oldState], [OLD_PREFS_KEY, oldPrefs]] as const) if (value !== undefined) present.push(key);
    // A profiles-v1 row with nothing recoverable falls back to the legacy prefs row, as 0.1.0 did.
    const parsed = parseOldState(oldState);
    if (!parsed && !isRecord(oldState) && !isRecord(oldPrefs) && rawHistory === undefined) return { migrated: false, note: null };
    state = parsed ?? freshState(parseLegacyPrefs(oldPrefs));
  } catch (e) {
    d.warn(`settings migration failed, keeping the old storage: ${errorText(e)}`);
    return { migrated: false, note: null };
  }
  try {
    await d.kv.set(SETTINGS_KEY, { v: SETTINGS_VERSION, ...state });
  } catch (e) {
    // Everything old stays; the store serves the validated legacy values from memory and writes them
    // with its next ordinary write, and a marker makes the history import retry on the next load.
    d.warn(`settings migration failed, keeping the old storage: ${errorText(e)}`);
    if (rawHistory !== undefined) await markHistoryPending(d);
    // The history row is not touched: its retry imports it and deletes it (and replaces the failure note).
    await setNote(d, rawHistory !== undefined ? MIGRATION_NOTE_FAILED_IMPORT : MIGRATION_NOTE);
    return { migrated: false, note: null, recovered: state, cleanup: async () => { for (const key of present) await deleteRow(d, key); } };
  }

  let note = MIGRATION_NOTE;
  if (rawHistory !== undefined) {
    const entries = parseOldHistory(rawHistory, state.shared.historyMaxEntries);
    if (!(await importHistory(d, entries))) {
      note = MIGRATION_NOTE_FAILED_IMPORT;
      await markHistoryPending(d);
    }
  }
  for (const key of present) await deleteRow(d, key);
  await setNote(d, note);
  return { migrated: true, note };
}

async function markHistoryPending(d: Deps): Promise<void> {
  try {
    await d.kv.set(HISTORY_PENDING_KEY, true);
  } catch (e) {
    d.warn(`could not mark the history import as pending: ${errorText(e)}`);
  }
}
