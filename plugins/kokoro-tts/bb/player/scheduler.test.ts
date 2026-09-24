import { test } from "node:test";
import assert from "node:assert/strict";
import { PcmScheduler } from "./scheduler.ts";

test("frames play back to back after a short lead", () => {
  const s = new PcmScheduler(0.05);
  assert.equal(s.next(10, 0.5), 10.05);
  assert.equal(s.next(10.1, 0.5), 10.55);
  assert.equal(s.end, 11.05);
});

test("an underrun restarts from now plus lead", () => {
  const s = new PcmScheduler(0.05);
  s.next(10, 0.5);
  assert.equal(s.next(20, 0.25), 20.05);
});
