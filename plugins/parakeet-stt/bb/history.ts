import { randomUUID } from "node:crypto";
import type { KvLike } from "./prefs.ts";
import { historyEntrySchema, type HistoryEntry } from "./schemas.ts";

export class HistoryStore {
  #kv: KvLike;
  #limit: () => number;
  #now: () => number;
  #id: () => string;

  constructor(kv: KvLike, limit: () => number, now: () => number = Date.now, id: () => string = randomUUID) {
    this.#kv = kv;
    this.#limit = limit;
    this.#now = now;
    this.#id = id;
  }

  async list(): Promise<HistoryEntry[]> {
    const parsed = historyEntrySchema.array().safeParse((await this.#kv.get<unknown>("history")) ?? []);
    return parsed.success ? parsed.data.slice(0, this.#limit()) : [];
  }

  async add(text: string, durationMs: number): Promise<void> {
    if (!text.trim() || this.#limit() === 0) return;
    const entry: HistoryEntry = { id: this.#id(), text, at: this.#now(), durationMs };
    await this.#kv.set("history", [entry, ...(await this.list())].slice(0, this.#limit()));
  }

  async clear(): Promise<void> {
    await this.#kv.set("history", []);
  }
}
