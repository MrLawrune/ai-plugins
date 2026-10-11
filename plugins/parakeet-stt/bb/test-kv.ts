// In-memory kv for tests. `writes` counts set() calls.
import type { KvLike } from "./prefs.ts";

export function memKv(initial: Record<string, unknown> = {}): KvLike & { data: Record<string, unknown>; writes: number } {
  const data = { ...initial };
  const kv = {
    data,
    writes: 0,
    async get<T>(k: string) { return data[k] as T | undefined; },
    async set(k: string, v: unknown) { kv.writes++; data[k] = structuredClone(v); },
  };
  return kv;
}
