import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_ID_KEY, DEVICE_NAME_KEY, guessDeviceName, readClientId, readDeviceName, regenerateClientId, writeDeviceName, type StorageLike } from "./device.ts";

const mem = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};

test("guessDeviceName", () => {
  assert.equal(guessDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "iPhone");
  assert.equal(guessDeviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari"), "Android phone");
  assert.equal(guessDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)"), "Mac");
  assert.equal(guessDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "Windows PC");
  assert.equal(guessDeviceName("Mozilla/5.0 (X11; Linux x86_64)"), "Linux PC");
  assert.equal(guessDeviceName("curl/8"), "Browser");
});

test("client id is generated once and reused", () => {
  const s = mem();
  const a = readClientId(s, () => "id-1");
  const b = readClientId(s, () => "id-2");
  assert.equal(a, "id-1");
  assert.equal(b, "id-1");
});

test("client id is per tab: separate session stores get separate ids; device name is shared", () => {
  const shared = mem(); // localStorage: one per browser profile
  const tab1 = mem(); // sessionStorage: one per tab
  const tab2 = mem();
  let n = 0;
  const gen = () => `id-${++n}`;
  assert.notEqual(readClientId(tab1, gen), readClientId(tab2, gen));
  assert.equal(CLIENT_ID_KEY, "kokoro-tts:tabClientId");
  writeDeviceName(shared, "Desk");
  assert.equal(readDeviceName(shared, "ua"), "Desk");
  assert.equal(tab1.data.has(DEVICE_NAME_KEY), false);
});

test("regenerateClientId overwrites the stored id with a fresh one", () => {
  const s = mem();
  const original = readClientId(s, () => "id-1");
  const fresh = regenerateClientId(s, () => "id-2");
  assert.equal(original, "id-1");
  assert.equal(fresh, "id-2");
  assert.equal(readClientId(s, () => "id-3"), "id-2");
});

test("client id defaults to a random UUID", () => {
  const id = readClientId(mem());
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("device name: stored, trimmed, capped, else guessed", () => {
  const s = mem();
  assert.equal(readDeviceName(s, "Mozilla/5.0 (X11; Linux x86_64)"), "Linux PC");
  writeDeviceName(s, `  ${"x".repeat(80)}  `);
  assert.equal(s.data.get(DEVICE_NAME_KEY)?.length, 64);
  writeDeviceName(s, "Desk");
  assert.equal(readDeviceName(s, "whatever"), "Desk");
});
