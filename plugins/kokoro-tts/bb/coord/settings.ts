import { DEFAULT_SETTINGS, settingsPatchSchema, settingsSchema, type Settings, type SettingsPatch } from "../schemas.ts";

export interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Field-by-field validation: each key of `raw` that parses under settingsSchema.shape[key] wins, others take defaults. */
export function coerceSettings(raw: unknown): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const src = raw as Record<string, unknown>;
    for (const key of Object.keys(settingsSchema.shape) as (keyof Settings)[]) {
      if (key === "v" || !(key in src)) continue;
      const parsed = settingsSchema.shape[key].safeParse(src[key]);
      if (parsed.success) out[key] = parsed.data;
    }
  }
  return out as Settings;
}

type Listener = (next: Settings, prev: Settings) => void;

export class SettingsStore {
  #kv: KvLike;
  #cache: Settings = DEFAULT_SETTINGS;
  #listeners = new Set<Listener>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(kv: KvLike) {
    this.#kv = kv;
  }

  /** Loads the `settings` row; returns null when there is none yet (migration needed). Invalid fields fall back to defaults one by one. */
  async load(): Promise<Settings | null> {
    const raw = await this.#kv.get<unknown>("settings");
    if (raw === undefined || raw === null) return null;
    this.#cache = coerceSettings(raw);
    return this.#cache;
  }

  get(): Settings {
    return this.#cache;
  }

  /** Writes a whole row (migration). */
  replace(next: Settings): Promise<Settings> {
    return this.#enqueue(() => settingsSchema.parse(next));
  }

  /** Validated patch, applied in call order, each on top of the last committed settings. Throws ZodError on invalid input. */
  update(patch: SettingsPatch): Promise<Settings> {
    return this.#enqueue(() => settingsSchema.parse({ ...this.#cache, ...settingsPatchSchema.parse(patch) }));
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #enqueue(compute: () => Settings): Promise<Settings> {
    const run = async () => {
      const next = compute();
      const prev = this.#cache;
      await this.#kv.set("settings", next);
      this.#cache = next;
      for (const l of this.#listeners) l(next, prev);
      return next;
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

export class MuteStore {
  #kv: KvLike;
  #muted = false;
  #listeners = new Set<(muted: boolean) => void>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(kv: KvLike) {
    this.#kv = kv;
  }

  /** Loads the `muted` row; anything but `true` reads as unmuted. */
  async load(): Promise<boolean> {
    this.#muted = (await this.#kv.get<unknown>("muted")) === true;
    return this.#muted;
  }

  get(): boolean {
    return this.#muted;
  }

  set(muted: boolean): Promise<boolean> {
    const run = async () => {
      const prev = this.#muted;
      await this.#kv.set("muted", muted);
      this.#muted = muted;
      if (prev !== muted) for (const l of this.#listeners) l(muted);
      return muted;
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  onChange(listener: (muted: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
