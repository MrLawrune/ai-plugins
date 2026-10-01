import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../schemas.ts";
import { MuteStore, SettingsStore, coerceSettings, type KvLike } from "./settings.ts";

function memKv(initial: Record<string, unknown> = {}): KvLike & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { data, async get<T>(k: string) { return data[k] as T | undefined; }, async set(k, v) { data[k] = v; } };
}

test("load returns null when no row exists", async () => {
  assert.equal(await new SettingsStore(memKv()).load(), null);
});
test("load keeps valid fields and defaults invalid ones individually", async () => {
  const s = new SettingsStore(memKv({ settings: { ...DEFAULT_SETTINGS, speed: 9, voice: "bm_george" } }));
  const got = await s.load();
  assert.equal(got!.speed, 1); assert.equal(got!.voice, "bm_george");
});
test("update validates, persists, and notifies in order", async () => {
  const kv = memKv(); const s = new SettingsStore(kv); await s.replace(DEFAULT_SETTINGS);
  const seen: number[] = []; s.onChange((n) => seen.push(n.speed));
  await Promise.all([s.update({ speed: 1.2 }), s.update({ speed: 1.4 })]);
  assert.deepEqual(seen, [1.2, 1.4]); assert.equal((kv.data.settings as { speed: number }).speed, 1.4);
});
test("update rejects out-of-range retention", async () => {
  const s = new SettingsStore(memKv()); await s.replace(DEFAULT_SETTINGS);
  await assert.rejects(s.update({ retention: { maxAgeDays: 0, maxEntries: 1000 } }));
  await assert.rejects(s.update({ retention: { maxAgeDays: 7, maxEntries: 50 } }));
});
test("coerceSettings rejects unknown keys silently", () => {
  assert.deepEqual(coerceSettings({ bogus: 1 }), DEFAULT_SETTINGS);
});
test("MuteStore persists", async () => {
  const kv = memKv(); const m = new MuteStore(kv); await m.load();
  await m.set(true); assert.equal(kv.data.muted, true);
  const again = new MuteStore(kv); assert.equal(await again.load(), true);
});
test("a rejected update persists nothing and does not block later updates", async () => {
  const kv = memKv(); const s = new SettingsStore(kv); await s.replace(DEFAULT_SETTINGS);
  const bad = s.update({ speed: 5 }); const good = s.update({ speed: 0.8 });
  await assert.rejects(bad); assert.equal((await good).speed, 0.8);
  assert.equal(s.get().speed, 0.8); assert.equal((kv.data.settings as { speed: number }).speed, 0.8);
});
test("MuteStore notifies only on change", async () => {
  const m = new MuteStore(memKv()); await m.load();
  const seen: boolean[] = []; m.onChange((v) => seen.push(v));
  await m.set(true); await m.set(true); await m.set(false);
  assert.deepEqual(seen, [true, false]);
});
