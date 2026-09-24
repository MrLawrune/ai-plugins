import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientRegistry } from "./clients.ts";

function setup() {
  let t = 1_000_000;
  const reg = new ClientRegistry(() => t, 45_000);
  const add = (clientId: string, deviceName: string, focusedAt: number, audioUnlocked = true) =>
    reg.upsert({ clientId, deviceName, focusedAt, audioUnlocked });
  return { reg, add, advance: (ms: number) => { t += ms; } };
}

test("follow picks the most recently focused unlocked window", () => {
  const { reg, add } = setup();
  add("a", "Desktop", 10);
  add("b", "Phone", 30);
  add("c", "Laptop", 50, false);
  assert.deepEqual(reg.select("follow", null), ["b"]);
});

test("pinned picks the device's most recent window, else follows", () => {
  const { reg, add } = setup();
  add("a", "Desktop", 10);
  add("a2", "Desktop", 20);
  add("b", "Phone", 30);
  assert.deepEqual(reg.select("pinned", "Desktop"), ["a2"]);
  assert.deepEqual(reg.select("pinned", "Tablet"), ["b"]);
});

test("all returns every unlocked window", () => {
  const { reg, add } = setup();
  add("a", "Desktop", 10);
  add("b", "Phone", 30);
  add("c", "Laptop", 50, false);
  assert.deepEqual(reg.select("all", null).sort(), ["a", "b"]);
});

test("exclude skips already-tried windows", () => {
  const { reg, add } = setup();
  add("a", "Desktop", 10);
  add("b", "Phone", 30);
  assert.deepEqual(reg.select("follow", null, new Set(["b"])), ["a"]);
});

test("windows silent for 45 s expire; update refreshes lastSeen", () => {
  const { reg, add, advance } = setup();
  add("a", "Desktop", 10);
  add("b", "Phone", 30);
  advance(40_000);
  reg.update("a", {});
  advance(10_000);
  assert.deepEqual(reg.live().map((c) => c.clientId), ["a"]);
});

test("update changes focus order and unlock state", () => {
  const { reg, add } = setup();
  add("a", "Desktop", 10, false);
  add("b", "Phone", 30);
  reg.update("a", { focusedAt: 99, audioUnlocked: true });
  assert.deepEqual(reg.select("follow", null), ["a"]);
});

test("no windows -> empty selection", () => {
  const { reg } = setup();
  assert.deepEqual(reg.select("follow", null), []);
});

test("default TTL: a client pinging every 60 s (Chrome's throttled background-tab interval) stays selectable throughout", () => {
  let t = 1_000_000;
  const reg = new ClientRegistry(() => t); // no ttlMs override: exercises the 150 s default
  reg.upsert({ clientId: "a", deviceName: "Desktop", focusedAt: 10, audioUnlocked: true });
  for (let i = 0; i < 10; i++) {
    t += 60_000;
    reg.update("a", {});
    assert.deepEqual(reg.select("all", null), ["a"], `still selectable after ping ${i + 1}`);
  }
});

test("default TTL: a client silent for more than 150 s is pruned", () => {
  let t = 1_000_000;
  const reg = new ClientRegistry(() => t);
  reg.upsert({ clientId: "a", deviceName: "Desktop", focusedAt: 10, audioUnlocked: true });
  t += 150_000;
  assert.deepEqual(reg.live().map((c) => c.clientId), ["a"]); // exactly at the boundary: still live
  t += 1;
  assert.deepEqual(reg.live(), []); // past it: pruned
});
