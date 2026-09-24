import { prefsSchema, type Prefs } from "./schemas.ts";

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
  hideNativeMic: true,
  keepListeningHidden: true,
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
    const parsed = prefsSchema.safeParse({ ...DEFAULT_PREFS, ...((await this.#kv.get<object>("prefs")) ?? {}) });
    this.#cache = parsed.success ? parsed.data : DEFAULT_PREFS;
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
