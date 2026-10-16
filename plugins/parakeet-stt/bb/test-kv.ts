// In-memory kv for tests. `writes` counts set() calls; `deleted` lists delete()d keys in order.
import type { KvLike } from "./prefs.ts";

export function memKv(initial: Record<string, unknown> = {}): KvLike & {
  data: Record<string, unknown>;
  writes: number;
  deleted: string[];
  delete(k: string): Promise<void>;
} {
  const data = { ...initial };
  const kv = {
    data,
    writes: 0,
    deleted: [] as string[],
    async get<T>(k: string) { return data[k] as T | undefined; },
    async set(k: string, v: unknown) { kv.writes++; data[k] = structuredClone(v); },
    async delete(k: string) { kv.deleted.push(k); delete data[k]; },
  };
  return kv;
}
