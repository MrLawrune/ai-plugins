// Dictation prefs: shared settings plus named per-device profiles, and the devices that use them.
// Each browser registers with a random id (see device.ts) and gets the profile for its kind until
// it is assigned another one.
import {
  deviceKindSchema,
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
  historyLimit: 5,
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
const MAX_PROFILES = 20;
const MAX_DEVICES = 50;
const STATE_KEY = "profiles-v1";

export interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

interface Profile { name: string; prefs: ProfilePrefs }
interface State {
  shared: SharedPrefs;
  profiles: Record<string, Profile>;
  devices: Record<string, DeviceRecord>;
}

type Listener = (next: Prefs, prev: Prefs) => void;

const isProfileKey = (k: string): k is ProfileKey => (PROFILE_KEYS as readonly string[]).includes(k);

function split(p: Prefs): { shared: SharedPrefs; profile: ProfilePrefs } {
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
function freshState(base: Prefs): State {
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

export class PrefsStore {
  #kv: KvLike;
  #state: State = freshState(DEFAULT_PREFS);
  #listeners = new Set<Listener>();

  constructor(kv: KvLike) {
    this.#kv = kv;
  }

  async load(): Promise<void> {
    const stored = await this.#kv.get<State>(STATE_KEY);
    if (stored?.profiles && Object.keys(stored.profiles).length) {
      const shared = split(parsePrefs(stored.shared)).shared;
      const profiles: Record<string, Profile> = {};
      for (const [id, p] of Object.entries(stored.profiles)) {
        profiles[id] = { name: p.name, prefs: split(parsePrefs({ ...shared, ...p.prefs })).profile };
      }
      const devices: Record<string, DeviceRecord> = {};
      for (const [id, d] of Object.entries(stored.devices ?? {})) {
        devices[id] = { ...d, kind: deviceKindSchema.catch("desktop").parse(d.kind) };
      }
      // The earlier Phone profile is the touch-screen profile.
      if (profiles.phone && !profiles.touch) {
        profiles.touch = { ...profiles.phone, name: profiles.phone.name === "Phone" ? KIND_PROFILE_NAMES.touch : profiles.phone.name };
        delete profiles.phone;
        for (const d of Object.values(devices)) if (d.profileId === "phone") d.profileId = "touch";
      }
      this.#state = { shared, profiles, devices };
      return;
    }
    // Settings saved before profiles existed seed every starter profile.
    this.#state = freshState(parsePrefs(await this.#kv.get<object>("prefs")));
  }

  /** Effective prefs for a profile (unknown ids fall back to the first profile). */
  get(profileId?: string): Prefs {
    const profile = (profileId && this.#state.profiles[profileId]) || Object.values(this.#state.profiles)[0]!;
    return { ...this.#state.shared, ...profile.prefs };
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

  /** Register a browser (or refresh its last-seen time). New devices get their kind's profile. */
  async hello(id: string, name: string, kind: DeviceKind, now: number): Promise<DeviceRecord> {
    const known = this.#state.devices[id];
    const device: DeviceRecord = known
      ? { ...known, lastSeen: now }
      : { id, name, kind, profileId: this.#kindProfile(kind), lastSeen: now };
    this.#state.devices[id] = device;
    for (const d of this.devices().slice(MAX_DEVICES)) delete this.#state.devices[d.id];
    await this.#save();
    return device;
  }

  async updateDevice(id: string, patch: { name?: string; profileId?: string }): Promise<DeviceRecord> {
    const d = this.#state.devices[id];
    if (!d) throw new Error("unknown device");
    if (patch.profileId !== undefined && !this.#state.profiles[patch.profileId]) throw new Error("unknown profile");
    const next: DeviceRecord = { ...d, name: patch.name ?? d.name, profileId: patch.profileId ?? d.profileId };
    this.#state.devices[id] = next;
    await this.#save();
    return next;
  }

  async forgetDevice(id: string): Promise<void> {
    delete this.#state.devices[id];
    await this.#save();
  }

  async createProfile(name: string, copyFrom: string): Promise<ProfileInfo> {
    if (Object.keys(this.#state.profiles).length >= MAX_PROFILES) throw new Error(`at most ${MAX_PROFILES} profiles`);
    const id = this.#newId(name);
    this.#state.profiles[id] = { name, prefs: split(this.get(copyFrom)).profile };
    await this.#save();
    return { id, name };
  }

  async renameProfile(id: string, name: string): Promise<ProfileInfo> {
    const p = this.#state.profiles[id];
    if (!p) throw new Error("unknown profile");
    p.name = name;
    await this.#save();
    return { id, name };
  }

  /** Delete a profile; its devices move to their kind's profile (or the first). The last cannot be deleted. */
  async deleteProfile(id: string): Promise<void> {
    if (!this.#state.profiles[id]) throw new Error("unknown profile");
    if (Object.keys(this.#state.profiles).length === 1) throw new Error("the last profile cannot be deleted");
    delete this.#state.profiles[id];
    const first = Object.keys(this.#state.profiles)[0]!;
    for (const d of Object.values(this.#state.devices)) {
      if (d.profileId === id) d.profileId = this.#state.profiles[d.kind] ? d.kind : first;
    }
    await this.#save();
  }

  /** Apply a patch: shared keys change every profile, the rest only `profileId`. */
  async update(profileId: string, patch: Partial<Prefs>): Promise<Prefs> {
    const profile = this.#state.profiles[profileId];
    if (!profile) throw new Error("unknown profile");
    const prev = this.get(profileId);
    const next = prefsSchema.parse({ ...prev, ...patch });
    const parts = split(next);
    this.#state.shared = parts.shared;
    profile.prefs = parts.profile;
    await this.#save();
    for (const l of this.#listeners) l(next, prev);
    return next;
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The profile for a device kind, created from Desktop when missing. */
  #kindProfile(kind: DeviceKind): string {
    if (this.#state.profiles[kind]) return kind;
    const ids = Object.keys(this.#state.profiles);
    if (ids.length >= MAX_PROFILES) return ids[0]!;
    this.#state.profiles[kind] = { name: KIND_PROFILE_NAMES[kind], prefs: split(this.get("desktop")).profile };
    return kind;
  }

  #newId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "profile";
    let id = base;
    for (let n = 2; this.#state.profiles[id]; n++) id = `${base}-${n}`;
    return id;
  }

  async #save(): Promise<void> {
    await this.#kv.set(STATE_KEY, this.#state);
  }
}
