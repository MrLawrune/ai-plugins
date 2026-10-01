import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS, PrefsStore, type KvLike } from "./prefs.ts";

function memKv(initial: Record<string, unknown> = {}): KvLike & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { data, async get<T>(k: string) { return data[k] as T | undefined; }, async set(k, v) { data[k] = v; } };
}

test("load falls back to defaults and ignores invalid stored fields", async () => {
  const store = new PrefsStore(memKv({ prefs: { runtime: "gpu", playOn: "loud" } }));
  const p = await store.load();
  assert.equal(p.runtime, "cpu"); // whole stored object invalid -> defaults
  assert.deepEqual(p, DEFAULT_PREFS);
});

test("load keeps valid stored fields", async () => {
  const store = new PrefsStore(memKv({ prefs: { runtime: "gpu", playOn: "pinned", pinnedDevice: "Desk" } }));
  const p = await store.load();
  assert.equal(p.runtime, "gpu");
  assert.equal(p.pinnedDevice, "Desk");
});

test("a stored playback field loads without error and is dropped", async () => {
  const store = new PrefsStore(memKv({ prefs: { runtime: "gpu", playback: "server" } }));
  const p = await store.load();
  assert.equal(p.runtime, "gpu");
  assert.equal("playback" in p, false);
  assert.deepEqual(p, { ...DEFAULT_PREFS, runtime: "gpu" });
});

test("update validates, persists, and notifies", async () => {
  const kv = memKv();
  const store = new PrefsStore(kv);
  await store.load();
  const seen: string[] = [];
  store.onChange((n, p) => seen.push(`${p.runtime}->${n.runtime}`));
  await store.update({ runtime: "gpu" });
  assert.deepEqual(seen, ["cpu->gpu"]);
  assert.equal((kv.data.prefs as { runtime: string }).runtime, "gpu");
  await assert.rejects(store.update({ runtime: "tpu" as never }));
  assert.equal(store.get().runtime, "gpu");
});

test("concurrent updates both persist", async () => {
  const data: Record<string, unknown> = {};
  const slowKv: KvLike = {
    async get<T>(k: string) { return data[k] as T | undefined; },
    async set(k, v) { await new Promise((r) => setTimeout(r, 5)); data[k] = v; },
  };
  const store = new PrefsStore(slowKv);
  await store.load();
  await Promise.all([store.update({ runtime: "gpu" }), store.update({ playOn: "all" })]);
  assert.equal(store.get().runtime, "gpu");
  assert.equal(store.get().playOn, "all");
  assert.deepEqual(data.prefs, store.get());
});

test("a failed write keeps the old value and does not block the next write", async () => {
  let fail = true;
  const data: Record<string, unknown> = {};
  const kv: KvLike = {
    async get<T>(k: string) { return data[k] as T | undefined; },
    async set(k, v) { if (fail) { fail = false; throw new Error("kv down"); } data[k] = v; },
  };
  const store = new PrefsStore(kv);
  await store.load();
  await assert.rejects(store.update({ runtime: "gpu" }), /kv down/);
  assert.equal(store.get().runtime, "cpu");
  await store.update({ playOn: "all" });
  assert.equal(store.get().playOn, "all");
});
