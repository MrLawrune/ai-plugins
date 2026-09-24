import { test } from "node:test";
import assert from "node:assert/strict";
import { createPressDetector } from "./press.ts";

function setup() {
  const log: string[] = [];
  let fire: (() => void) | null = null;
  const d = createPressDetector({
    holdMs: 350,
    onTap: () => log.push("tap"),
    onHoldStart: () => log.push("hold-start"),
    onHoldEnd: () => log.push("hold-end"),
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
  });
  return { d, log, fire: () => fire?.() };
}

test("short press is a tap", () => {
  const s = setup();
  s.d.down(); s.d.up();
  assert.deepEqual(s.log, ["tap"]);
});

test("long press holds until release", () => {
  const s = setup();
  s.d.down(); s.fire(); s.d.up();
  assert.deepEqual(s.log, ["hold-start", "hold-end"]);
});

test("cancel during a hold ends it; cancel before the timer does nothing", () => {
  const a = setup();
  a.d.down(); a.fire(); a.d.cancel();
  assert.deepEqual(a.log, ["hold-start", "hold-end"]);
  const b = setup();
  b.d.down(); b.d.cancel(); b.fire();
  assert.deepEqual(b.log, []);
});
