// Dictation prefs: shared settings plus named per-device profiles, and the devices that use them.
// Each browser registers with a random id (see device.ts) and gets the profile for its kind until
// it is assigned another one.
import {
  deviceKindSchema,
  idSchema,
  nameSchema,
  PROFILE_KEYS,
  prefsSchema,
  type DeviceKind,
  type DeviceRecord,
  type Prefs,
  type ProfileInfo,
  type ProfileKey,
  type ProfilePrefs,
  type SharedPrefs,
} from "./schemas.ts";

export const DEFAULT_PREFS: Prefs = {
  shortcut: "ctrl+space",
  holdToTalk: false,
  autoSubmit: false,
  trailingSpace: false,
  soundCues: true,
  customWords: [],
  removeFillers: true,
  correctionThreshold: 0.18,
  historyMaxEntries: 50,
  historyMaxAgeDays: 7,
  mode: "continuous",
  livePreview: true,
  pauseMs: 600,
  endOnSilence: false,
  silenceTimeoutS: 8,
  voiceCommands: false,
  sendPhrase: "send it",
  stopPhrase: "stop listening",
  clearPhrase: "clear all response text",
  waitForStart: false,
  startPhrases: ["start new reply", "send new message"],
  hideNativeMic: true,
  keepListeningHidden: true,
  floatingMic: true,
  expandCompactDraft: true,
};

export const KIND_PROFILE_NAMES: Record<DeviceKind, string> = { touch: "Touch screen", desktop: "Desktop" };
export const MAX_PROFILES = 20;
const MAX_DEVICES = 50;
/** Stored `{ v: 2, shared, profiles, devices }` row. */
export const SETTINGS_KEY = "settings";
export const SETTINGS_VERSION = 2;
/** A known device's stored last-seen time is refreshed at most this often. */
const LAST_SEEN_WRITE_MS = 600_000;

export interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface Profile { name: string; prefs: ProfilePrefs }
export interface State {
  shared: SharedPrefs;
  profiles: Record<string, Profile>;
  devices: Record<string, DeviceRecord>;
}

type Listener = (next: Prefs, prev: Prefs) => void;

const isProfileKey = (k: string): k is ProfileKey => (PROFILE_KEYS as readonly string[]).includes(k);

export function split(p: Prefs): { shared: SharedPrefs; profile: ProfilePrefs } {
  const shared: Record<string, unknown> = {};
  const profile: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) (isProfileKey(k) ? profile : shared)[k] = v;
  return { shared: shared as SharedPrefs, profile: profile as ProfilePrefs };
}

/** Prefs from a stored object, validated field by field: an invalid or missing field takes its default. */
export function parsePrefs(raw: unknown): Prefs {
  const src = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = { ...DEFAULT_PREFS };
  for (const [key, schema] of Object.entries(prefsSchema.shape)) {
    const parsed = schema.safeParse(src[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as Prefs;
}

/** Starter state: `base` becomes the shared settings and the Desktop and Touch screen profiles. */
export function freshState(base: Prefs): State {
  const { shared, profile } = split(base);
  return {
    shared,
    profiles: {
      desktop: { name: KIND_PROFILE_NAMES.desktop, prefs: { ...profile } },
      touch: { name: KIND_PROFILE_NAMES.touch, prefs: { ...profile } },
    },
    devices: {},
  };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A device with an unusable id is dropped; its other fields fall back (unknown kind: desktop, empty name: "Device"). */
function parseDevice(d: unknown): DeviceRecord | null {
  if (!isRecord(d)) return null;
  const id = idSchema.safeParse(d.id);
  if (!id.success) return null;
  const kind = deviceKindSchema.catch("desktop").parse(d.kind);
  return {
    id: id.data,
    name: nameSchema.catch("Device").parse(d.name),
    kind,
    profileId: idSchema.catch(kind).parse(d.profileId),
    lastSeen: typeof d.lastSeen === "number" && Number.isFinite(d.lastSeen) ? d.lastSeen : 0,
  };
}

/** Name of a profile whose stored name is unusable: its kind's name, else its id. */
const fallbackName = (id: string): string => (id in KIND_PROFILE_NAMES ? KIND_PROFILE_NAMES[id as DeviceKind] : id);

/** A valid, unused profile id for a stored key that is not one (`bad id!` becomes `bad-id`). */
function repairedId(key: string, taken: Record<string, Profile>): string {
  const base = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "profile";
  let id = base;
  for (let n = 2; taken[id]; n++) id = `${base}-${n}`;
  return id;
}

/**
 * The shared prefs, profiles and devices of a stored row, recovered piece by piece (`parse` reads one
 * prefs object): shared fields independently of the profiles, a profile with unusable metadata keeps
 * its preferences under a repaired id or name, and starter profiles stand in when none is left.
 * Null only when the row holds nothing recoverable (no shared object and no profile object).
 */
export function parseRows(raw: Record<string, unknown>, parse: (raw: unknown) => Prefs = parsePrefs): State | null {
  const entries = isRecord(raw.profiles) ? Object.entries(raw.profiles).filter(([, p]) => isRecord(p)) : [];
  if (!isRecord(raw.shared) && !entries.length) return null;
  const shared = split(parse(raw.shared)).shared;
  const profiles: Record<string, Profile> = {};
  for (const [key, p] of entries) {
    if (Object.keys(profiles).length >= MAX_PROFILES) break;
    const stored = p as Record<string, unknown>;
    const id = idSchema.safeParse(key).success && !profiles[key] ? key : repairedId(key, profiles);
    const name = nameSchema.catch(fallbackName(id)).parse(stored.name);
    profiles[id] = { name, prefs: split(parse({ ...shared, ...(isRecord(stored.prefs) ? stored.prefs : {}) })).profile };
  }
  const devices: Record<string, DeviceRecord> = {};
  if (isRecord(raw.devices)) {
    for (const d of Object.values(raw.devices)) {
      const device = parseDevice(d);
      if (device) devices[device.id] = device;
    }
  }
  return {
    shared,
    profiles: Object.keys(profiles).length ? profiles : freshState(parse(raw.shared)).profiles,
    devices: trimDevices(devices),
  };
}

/** Validate a stored v2 row; null when it is not a usable one. */
function parseState(raw: unknown): State | null {
  return isRecord(raw) && raw.v === SETTINGS_VERSION ? parseRows(raw) : null;
}

export function trimDevices(devices: Record<string, DeviceRecord>): Record<string, DeviceRecord> {
  const kept = Object.values(devices).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_DEVICES);
  return Object.fromEntries(kept.map((d) => [d.id, d]));
}

/** Effective prefs of one profile in `state` (unknown ids fall back to the first profile). */
function effective(state: State, profileId?: string): Prefs {
  const profile = (profileId && state.profiles[profileId]) || Object.values(state.profiles)[0]!;
  return { ...state.shared, ...profile.prefs };
}

export class PrefsStore {
  #kv: KvLike;
  #state: State = freshState(DEFAULT_PREFS);
  #listeners = new Set<Listener>();
  #queue: Promise<void> = Promise.resolve();
  /** `lastSeen` per device as last written to kv (the in-memory value runs ahead of it between writes). */
  #stored = new Map<string, number>();
  /** Set while the stored row could not be read: the state is defaults and nothing may be written over the row. */
  #unreadable: string | null = null;
  #recovered: { state: State; done?: () => Promise<void> } | undefined;
  #afterFirstWrite: (() => Promise<void>) | undefined; // runs once, after the first successful write of a recovered state

  constructor(kv: KvLike) {
    this.#kv = kv;
  }

  /**
   * Read the `settings` row. A missing or unusable row leaves `fallback` (the state recovered from the
   * 0.1.0 rows by a failed migration) or the defaults in place; a row that cannot be read at all leaves
   * read-only defaults, see `unreadable`. Never throws.
   */
  async load(fallback?: State, done?: () => Promise<void>): Promise<void> {
    if (fallback) this.#recovered = { state: fallback, done };
    const recovered = this.#recovered;
    this.#afterFirstWrite = undefined;
    try {
      const stored = parseState(await this.#kv.get<unknown>(SETTINGS_KEY));
      this.#state = stored ?? (recovered ? structuredClone(recovered.state) : freshState(DEFAULT_PREFS));
      if (!stored) this.#afterFirstWrite = recovered?.done;
      this.#unreadable = null;
    } catch (e) {
      this.#state = recovered ? structuredClone(recovered.state) : freshState(DEFAULT_PREFS);
      this.#afterFirstWrite = recovered?.done;
      this.#unreadable = e instanceof Error && e.message ? e.message : String(e);
    }
    this.#rememberStored(this.#state);
  }

  /** Why the stored settings could not be read (reads serve defaults and writes are refused until a read works), or null. */
  get unreadable(): string | null {
    return this.#unreadable;
  }

  /** Effective prefs for a profile (unknown ids fall back to the first profile). */
  get(profileId?: string): Prefs {
    return effective(this.#state, profileId);
  }

  /** Effective prefs for a registered device, or the first profile when unknown. */
  forDevice(deviceId: string | null | undefined): Prefs {
    return this.get(deviceId ? this.#state.devices[deviceId]?.profileId : undefined);
  }

  profiles(): ProfileInfo[] {
    return Object.entries(this.#state.profiles).map(([id, p]) => ({ id, name: p.name }));
  }

  devices(): DeviceRecord[] {
    return Object.values(this.#state.devices).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /**
   * Register a browser (or refresh its last-seen time). New devices get their kind's profile; a
   * known device keeps its name, kind and profile (the browser only guesses a name, the user renames it).
   * The row is written only for a new device or when the last-seen time in the stored row is 10
   * minutes old; other page loads just update the time in memory.
   */
  hello(id: string, name: string, kind: DeviceKind, now: number): Promise<DeviceRecord> {
    return this.#enqueue(async () => {
      const known = this.#state.devices[id];
      if (known && now - (this.#stored.get(id) ?? known.lastSeen) < LAST_SEEN_WRITE_MS) {
        const device = { ...known, lastSeen: now };
        this.#state.devices[id] = device;
        return device;
      }
      const draft = this.#draft();
      const device: DeviceRecord = known
        ? { ...known, lastSeen: now }
        : { id, name, kind, profileId: this.#kindProfile(draft, kind), lastSeen: now };
      draft.devices[id] = device;
      draft.devices = trimDevices(draft.devices);
      await this.#commit(draft);
      return device;
    }, () => ({ id, name, kind, profileId: kind, lastSeen: now }));
  }

  updateDevice(id: string, patch: { name?: string; profileId?: string }): Promise<DeviceRecord> {
    return this.#enqueue(async () => {
      const draft = this.#draft();
      const d = draft.devices[id];
      if (!d) throw new Error("unknown device");
      if (patch.profileId !== undefined && !draft.profiles[patch.profileId]) throw new Error("unknown profile");
      const next: DeviceRecord = { ...d, name: patch.name ?? d.name, profileId: patch.profileId ?? d.profileId };
      draft.devices[id] = next;
      await this.#commit(draft);
      return next;
    });
  }

  forgetDevice(id: string): Promise<void> {
    return this.#enqueue(async () => {
      const draft = this.#draft();
      delete draft.devices[id];
      await this.#commit(draft);
    });
  }

  createProfile(name: string, copyFrom: string): Promise<ProfileInfo> {
    return this.#enqueue(async () => {
      const draft = this.#draft();
      if (Object.keys(draft.profiles).length >= MAX_PROFILES) throw new Error(`at most ${MAX_PROFILES} profiles`);
      const id = this.#newId(draft, name);
      draft.profiles[id] = { name, prefs: split(effective(draft, copyFrom)).profile };
      await this.#commit(draft);
      return { id, name };
    });
  }

  renameProfile(id: string, name: string): Promise<ProfileInfo> {
    return this.#enqueue(async () => {
      const draft = this.#draft();
      const p = draft.profiles[id];
      if (!p) throw new Error("unknown profile");
      p.name = name;
      await this.#commit(draft);
      return { id, name };
    });
  }

  /** Delete a profile; its devices move to their kind's profile (or the first). The last cannot be deleted. */
  deleteProfile(id: string): Promise<void> {
    return this.#enqueue(async () => {
      const draft = this.#draft();
      if (!draft.profiles[id]) throw new Error("unknown profile");
      if (Object.keys(draft.profiles).length === 1) throw new Error("the last profile cannot be deleted");
      delete draft.profiles[id];
      const first = Object.keys(draft.profiles)[0]!;
      for (const d of Object.values(draft.devices)) {
        if (d.profileId === id) d.profileId = draft.profiles[d.kind] ? d.kind : first;
      }
      await this.#commit(draft);
    });
  }

  /** Apply a patch: shared keys change every profile, the rest only `profileId`. */
  update(profileId: string, patch: Partial<Prefs>): Promise<Prefs> {
    return this.#enqueue(async () => {
      const draft = this.#draft();
      const profile = draft.profiles[profileId];
      if (!profile) throw new Error("unknown profile");
      const prev = effective(this.#state, profileId);
      const next = prefsSchema.parse({ ...prev, ...patch });
      const parts = split(next);
      draft.shared = parts.shared;
      profile.prefs = parts.profile;
      await this.#commit(draft);
      for (const l of this.#listeners) l(next, prev);
      return next;
    });
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Run `op` after every earlier mutation settled; a rejected op does not block the ones behind it.
   * While the stored row is unreadable it first retries the read; if that still fails the write is
   * refused (`op` is replaced by `whenUnreadable` when given, so a device can still register).
   */
  #enqueue<T>(op: () => Promise<T>, whenUnreadable?: () => T): Promise<T> {
    const result = this.#queue.then(async () => {
      if (this.#unreadable !== null) {
        await this.load();
        if (this.#unreadable !== null) {
          if (whenUnreadable) return whenUnreadable();
          throw new Error(`Settings are unavailable: the stored settings could not be read (${this.#unreadable})`);
        }
      }
      return op();
    });
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #draft(): State {
    return structuredClone(this.#state);
  }

  /** Persist `draft`, then make it the committed state; a failed write leaves the committed state alone. */
  async #commit(draft: State): Promise<void> {
    await this.#kv.set(SETTINGS_KEY, { v: SETTINGS_VERSION, ...draft });
    this.#state = draft;
    this.#rememberStored(draft);
    const after = this.#afterFirstWrite;
    this.#afterFirstWrite = undefined;
    await after?.().catch(() => undefined); // best-effort: the settings row exists now
  }

  #rememberStored(state: State): void {
    this.#stored = new Map(Object.values(state.devices).map((d) => [d.id, d.lastSeen]));
  }

  /** The profile for a device kind, created from Desktop when missing. */
  #kindProfile(state: State, kind: DeviceKind): string {
    if (state.profiles[kind]) return kind;
    const ids = Object.keys(state.profiles);
    if (ids.length >= MAX_PROFILES) return ids[0]!;
    state.profiles[kind] = { name: KIND_PROFILE_NAMES[kind], prefs: split(effective(state, "desktop")).profile };
    return kind;
  }

  #newId(state: State, name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "profile";
    let id = base;
    for (let n = 2; state.profiles[id]; n++) id = `${base}-${n}`;
    return id;
  }
}
