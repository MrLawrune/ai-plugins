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
  MAX_PROFILES,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  split,
  trimDevices,
  type Profile,
  type State,
} from "./prefs.ts";
import { deviceSchema, idSchema, nameSchema, prefsSchema, type DeviceRecord, type Prefs } from "./schemas.ts";

export const MIGRATION_NOTE_KEY = "migration-note";
export const MIGRATION_NOTE = "Settings moved to the new layout. History now keeps 7 days.";

const OLD_STATE_KEY = "profiles-v1";
const OLD_PREFS_KEY = "prefs";
const OLD_HISTORY_KEY = "history";
const OLD_KEYS = [OLD_STATE_KEY, OLD_PREFS_KEY, OLD_HISTORY_KEY];

export interface MigrateResult { migrated: boolean; note: string | null }

interface MigrateKv {
  get<T>(k: string): Promise<T | undefined>;
  set(k: string, v: unknown): Promise<void>;
  delete(k: string): Promise<void>;
}

/** 0.1.0 kept the newest `historyLimit` (0–50) entries; its default was 5. */
const historyLimitSchema = z.number().int().min(0).max(50);
const legacyEntrySchema = z.object({ text: z.string(), at: z.number().finite(), durationMs: z.number().finite() });

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

/** Prefs from a stored object, validated field by field (invalid or missing fields take their defaults). */
function parseLegacyPrefs(raw: unknown): Prefs {
  const src = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = { ...DEFAULT_PREFS };
  for (const [key, schema] of Object.entries(prefsSchema.shape)) {
    const parsed = schema.safeParse(src[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  const limit = historyLimitSchema.safeParse(src.historyLimit);
  if (limit.success) out.historyMaxEntries = limit.data;
  out.historyMaxAgeDays = DEFAULT_PREFS.historyMaxAgeDays;
  return out as Prefs;
}

/** The 0.1.0 `profiles-v1` row as the new state, or null when it holds no usable profile. */
function parseOldState(raw: unknown): State | null {
  if (!isRecord(raw) || !isRecord(raw.profiles)) return null;
  const shared = split(parseLegacyPrefs(raw.shared)).shared;
  const profiles: Record<string, Profile> = {};
  for (const [id, p] of Object.entries(raw.profiles)) {
    if (Object.keys(profiles).length >= MAX_PROFILES) break;
    if (!idSchema.safeParse(id).success) continue;
    const name = nameSchema.safeParse(isRecord(p) ? p.name : undefined);
    if (!name.success) continue;
    profiles[id] = { name: name.data, prefs: split(parseLegacyPrefs({ ...shared, ...(isRecord(p) && isRecord(p.prefs) ? p.prefs : {}) })).profile };
  }
  if (!Object.keys(profiles).length) return null;
  const devices: Record<string, DeviceRecord> = {};
  if (isRecord(raw.devices)) {
    for (const d of Object.values(raw.devices)) {
      const parsed = deviceSchema.safeParse(d);
      if (parsed.success) devices[parsed.data.id] = parsed.data;
    }
  }
  // The earlier Phone profile is the touch-screen profile.
  if (profiles.phone && !profiles.touch) {
    profiles.touch = { ...profiles.phone, name: profiles.phone.name === "Phone" ? KIND_PROFILE_NAMES.touch : profiles.phone.name };
    delete profiles.phone;
    for (const d of Object.values(devices)) if (d.profileId === "phone") d.profileId = "touch";
  }
  return { shared, profiles, devices: trimDevices(devices) };
}

/** Old history entries (newest first), skipping malformed ones. */
function parseOldHistory(raw: unknown): { text: string; at: number; durationMs: number }[] {
  if (!Array.isArray(raw)) return [];
  const entries: { text: string; at: number; durationMs: number }[] = [];
  for (const item of raw) {
    const parsed = legacyEntrySchema.safeParse(item);
    if (parsed.success) entries.push({ text: parsed.data.text, at: parsed.data.at, durationMs: parsed.data.durationMs });
  }
  return entries;
}

/**
 * Builds the `settings` row from the 0.1.0 rows when it does not exist yet, imports the old history
 * into the dictation log and deletes the old rows. The `settings` write comes first so a failure
 * before it leaves everything as it was; the history import follows it (once, so it can never
 * duplicate) and is best-effort, keeping the old `history` row when it fails.
 */
export async function migrate(deps: { kv: MigrateKv; log: Pick<DictationLog, "importLegacy">; warn: (m: string) => void }): Promise<MigrateResult> {
  const { kv, log, warn } = deps;
  let history: ReturnType<typeof parseOldHistory>;
  let state: State;
  try {
    if ((await kv.get<unknown>(SETTINGS_KEY)) !== undefined) return { migrated: false, note: null };
    const oldState = await kv.get<unknown>(OLD_STATE_KEY);
    const oldPrefs = await kv.get<unknown>(OLD_PREFS_KEY);
    // A profiles-v1 row without usable profiles falls back to the legacy prefs row, as 0.1.0 did.
    const parsed = parseOldState(oldState);
    if (!parsed && !isRecord(oldState) && !isRecord(oldPrefs)) return { migrated: false, note: null };
    state = parsed ?? freshState(parseLegacyPrefs(oldPrefs));
    history = parseOldHistory(await kv.get<unknown>(OLD_HISTORY_KEY)).slice(0, state.shared.historyMaxEntries);
    await kv.set(SETTINGS_KEY, { v: SETTINGS_VERSION, ...state });
  } catch (e) {
    warn(`settings migration failed, keeping the old storage: ${errorText(e)}`);
    return { migrated: false, note: null };
  }

  let keepHistory = false;
  try {
    log.importLegacy(history);
  } catch (e) {
    keepHistory = true;
    warn(`dictation history import failed: ${errorText(e)}`);
  }
  for (const key of OLD_KEYS) {
    if (keepHistory && key === OLD_HISTORY_KEY) continue;
    try {
      await kv.delete(key);
    } catch (e) {
      warn(`could not delete the old ${key} row: ${errorText(e)}`);
    }
  }
  try {
    await kv.set(MIGRATION_NOTE_KEY, MIGRATION_NOTE);
  } catch (e) {
    warn(`could not store the migration note: ${errorText(e)}`);
  }
  return { migrated: true, note: MIGRATION_NOTE };
}
