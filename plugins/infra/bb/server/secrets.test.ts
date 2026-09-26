import { test } from "node:test";
import assert from "node:assert/strict";
import { isCredentialMap, Secrets, type SecretSettingsHandle } from "./secrets.ts";

function memHandle(initial?: string): SecretSettingsHandle & { value: string | undefined } {
  const h = {
    value: initial,
    async get() { return { credentials: h.value }; },
    async experimental_set(v: { credentials: string | null }) { await new Promise((r) => setTimeout(r, 1)); h.value = v.credentials ?? undefined; return {}; },
  };
  return h;
}

test("set, get, has, and remove a connection secret", async () => {
  const s = new Secrets(memHandle());
  assert.equal(await s.get("c1"), null);
  await s.set("c1", "tok=en");
  assert.equal(await s.get("c1"), "tok=en");
  assert.equal(await s.has("c1"), true);
  await s.remove("c1");
  assert.equal(await s.has("c1"), false);
});

test("concurrent writes to different connections are all kept", async () => {
  const h = memHandle();
  const s = new Secrets(h);
  await Promise.all([s.set("a", "1"), s.set("b", "2"), s.set("c", "3")]);
  assert.deepEqual(JSON.parse(h.value!), { a: { secret: "1" }, b: { secret: "2" }, c: { secret: "3" } });
});

test("a corrupt stored value reads as empty and is replaced on write", async () => {
  const h = memHandle("{not json");
  const s = new Secrets(h);
  assert.equal(await s.get("a"), null);
  await s.set("a", "x");
  assert.deepEqual(JSON.parse(h.value!), { a: { secret: "x" } });
});

test("the settings field only accepts a credential map", () => {
  assert.ok(isCredentialMap(""));
  assert.ok(isCredentialMap('{"c1":{"secret":"s"}}'));
  for (const bad of ["hunter2", "[]", "null", '{"c1":"s"}', '{"c1":{"secret":1}}']) assert.equal(isCredentialMap(bad), false, bad);
});
