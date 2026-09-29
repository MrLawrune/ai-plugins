import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigCache } from "./config-cache.ts";
import { CONFIG_RESPONSE } from "./page/fixtures.ts";
import type { ConfigResponse } from "./schemas.ts";

test("set, setMuted and refresh keep the cache current", async () => {
  const cache = new ConfigCache(async () => ({ ...CONFIG_RESPONSE, muted: true }));
  assert.equal(cache.get(), null);
  cache.set(CONFIG_RESPONSE);
  cache.setMuted(true);
  assert.equal(cache.get()?.muted, true);
  assert.equal(cache.get()?.config.mode, "brief");
  await cache.refresh();
  assert.equal(cache.get()?.muted, true);
});

test("a fetch that started before a write does not overwrite it", async () => {
  let reply!: (r: ConfigResponse) => void;
  const cache = new ConfigCache(() => new Promise((r) => { reply = r; }));
  const patched = { ...CONFIG_RESPONSE, config: { ...CONFIG_RESPONSE.config, mode: "verbose" as const } };
  const stale = cache.refresh();
  cache.set(patched);
  reply(CONFIG_RESPONSE);
  assert.equal((await stale).config.mode, "verbose");
  assert.equal(cache.get()?.config.mode, "verbose");
  const staleMute = cache.refresh();
  cache.setMuted(true);
  reply(CONFIG_RESPONSE);
  await staleMute;
  assert.equal(cache.get()?.muted, true);
});

test("clear forgets the config, and a fetch from before it does not bring it back", async () => {
  let reply!: (r: ConfigResponse) => void;
  const cache = new ConfigCache(() => new Promise((r) => { reply = r; }));
  cache.set(CONFIG_RESPONSE);
  const old = cache.refresh();
  cache.clear();
  reply(CONFIG_RESPONSE);
  await old;
  assert.equal(cache.get(), null);
  const fresh = cache.refresh();
  reply({ ...CONFIG_RESPONSE, muted: true });
  await fresh;
  assert.equal(cache.get()?.muted, true);
});

test("current fetches only when nothing is cached", async () => {
  let fetches = 0;
  const cache = new ConfigCache(async () => { fetches++; return CONFIG_RESPONSE; });
  await cache.current();
  await cache.current();
  assert.equal(fetches, 1);
});

test("the poll waits a minute between fetches and backs off from 5 s to 60 s while the server is down", async () => {
  const controller = new AbortController();
  const replies: (ConfigResponse | Error)[] = [
    CONFIG_RESPONSE, new Error("down"), new Error("down"), new Error("down"), new Error("down"),
    new Error("down"), new Error("down"), CONFIG_RESPONSE, new Error("down"),
  ];
  const waits: number[] = [];
  const cache = new ConfigCache(async () => {
    const next = replies.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }, async (ms) => {
    waits.push(ms);
    if (replies.length === 0) controller.abort();
  });
  await cache.poll(controller.signal);
  assert.deepEqual(waits, [60_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 5_000]);
  assert.deepEqual(cache.get(), CONFIG_RESPONSE, "a failed fetch keeps the last config");
});
