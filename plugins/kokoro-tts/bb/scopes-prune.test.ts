import { test } from "node:test";
import assert from "node:assert/strict";
import { isNotFound, pruneScopes } from "./scopes-prune.ts";
import { VoiceScopes } from "./scopes.ts";

test("isNotFound matches only bb's thread-not-found error", () => {
  assert.equal(isNotFound({ status: 404, code: "thread_not_found" }), true);
  for (const e of [{ status: 404, code: null }, { status: 500 }, new Error("x"), null, "404"]) assert.equal(isNotFound(e), false);
});

test("prune forgets not-found threads, keeps found or unknown ones, and survives a failing forget", async () => {
  const m = new Map<string, unknown>();
  const s = new VoiceScopes({ get: async <T>(k: string) => m.get(k) as T | undefined, set: async (k, v) => { m.set(k, v); } });
  await s.load();
  await s.set("thread", "gone", { mode: "quiet" });
  await s.set("thread", "gone2", { mode: "quiet" });
  await s.set("thread", "here", { mode: "brief" });
  await s.learnParent("err", "here");
  const answers: Record<string, boolean | null> = { gone: false, gone2: false, here: true, err: null };
  let failOnce = true;
  const flaky = { get: () => s.get(), forget: async (id: string) => {
    if (failOnce) { failOnce = false; throw new Error("kv"); }
    await s.forget(id);
  } };
  await pruneScopes(flaky, async (id) => answers[id] ?? null, new AbortController().signal);
  // "gone" hit the failing forget and stays; prune carried on and dropped "gone2".
  assert.deepEqual(Object.keys(s.get().threads).sort(), ["gone", "here"]);
  assert.equal(s.parentOf("err"), "here");
});
