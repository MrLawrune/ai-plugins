// In-memory kv for tests.
import type { KvLike } from "./prefs.ts";

export function memKv(initial: Record<string, unknown> = {}): KvLike & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { data, async get<T>(k: string) { return data[k] as T | undefined; }, async set(k, v) { data[k] = v; } };
}
