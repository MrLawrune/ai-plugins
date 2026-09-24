import { prefsSchema, type Prefs } from "./schemas.ts";

export const DEFAULT_PREFS: Prefs = {
  manageServer: true,
  runtime: "cpu",
  playback: "client",
  playOn: "follow",
  pinnedDevice: null,
};

export interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

type Listener = (next: Prefs, prev: Prefs) => void;

export class PrefsStore {
  #kv: KvLike;
  #cache: Prefs = DEFAULT_PREFS;
  #listeners = new Set<Listener>();

  constructor(kv: KvLike) {
    this.#kv = kv;
  }

  async load(): Promise<Prefs> {
    const parsed = prefsSchema.partial().safeParse((await this.#kv.get<unknown>("prefs")) ?? {});
    this.#cache = { ...DEFAULT_PREFS, ...(parsed.success ? parsed.data : {}) };
    return this.#cache;
  }

  get(): Prefs {
    return this.#cache;
  }

  async update(patch: Partial<Prefs>): Promise<Prefs> {
    const next = prefsSchema.parse({ ...this.#cache, ...patch });
    const prev = this.#cache;
    await this.#kv.set("prefs", next);
    this.#cache = next;
    for (const l of this.#listeners) l(next, prev);
    return next;
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
