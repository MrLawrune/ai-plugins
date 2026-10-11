// Dictation prefs: shared settings plus named per-device profiles, and the devices that use them.
// Each browser registers with a random id (see device.ts) and gets the profile for its kind until
// it is assigned another one.
import {
  deviceSchema,
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

function parsePrefs(raw: unknown): Prefs {
  const parsed = prefsSchema.safeParse({ ...DEFAULT_PREFS, ...(raw && typeof raw === "object" ? raw : {}) });
  return parsed.success ? parsed.data : DEFAULT_PREFS;
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

/** Validate a stored row field by field; null when it is not a usable v2 row. */
function parseState(raw: unknown): State | null {
  if (!isRecord(raw) || raw.v !== SETTINGS_VERSION || !isRecord(raw.profiles)) return null;
  const shared = split(parsePrefs(raw.shared)).shared;
  const profiles: Record<string, Profile> = {};
  for (const [id, p] of Object.entries(raw.profiles).slice(0, MAX_PROFILES)) {
    const name = nameSchema.safeParse(isRecord(p) ? p.name : undefined);
    if (!name.success) continue;
    profiles[id] = { name: name.data, prefs: split(parsePrefs({ ...shared, ...(isRecord(p) && isRecord(p.prefs) ? p.prefs : {}) })).profile };
  }
  if (!Object.keys(profiles).length) return null;
  const devices: Record<string, DeviceRecord> = {};
  if (isRecord(raw.devices)) {
    for (const d of Object.values(raw.devices)) {
      const parsed = deviceSchema.safeParse(d);
      if (parsed.success) devices[parsed.data.id] = parsed.data;
    }
  }
  return { shared, profiles, devices: trimDevices(devices) };
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

  constructor(kv: KvLike) {
    this.#kv = kv;
  }

  /** Read the `settings` row; a missing or unusable row leaves the defaults in place. */
  async load(): Promise<void> {
    this.#state = parseState(await this.#kv.get<unknown>(SETTINGS_KEY)) ?? freshState(DEFAULT_PREFS);
    this.#rememberStored(this.#state);
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
    });
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

  /** Run `op` after every earlier mutation settled; a rejected op does not block the ones behind it. */
  #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op);
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
