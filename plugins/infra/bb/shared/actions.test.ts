import { test } from "node:test";
import assert from "node:assert/strict";
import { GUEST_ACTIONS, QEMU_ONLY_ACTIONS, snapshotNameError } from "./actions.ts";

test("snapshot names follow Proxmox's configid rule", () => {
  for (const ok of ["pre_upgrade", "a1", "Before-2026", "x".repeat(40)]) assert.equal(snapshotNameError(ok), null, ok);
  assert.match(snapshotNameError("")!, /name/i);
  assert.match(snapshotNameError("a")!, /2-40/);
  assert.match(snapshotNameError("1abc")!, /start with a letter/);
  assert.match(snapshotNameError("has space")!, /letters, digits/);
  assert.match(snapshotNameError("x".repeat(41))!, /2-40/);
  assert.match(snapshotNameError("current")!, /reserved/);
  assert.match(snapshotNameError("vzdump")!, /reserved/);
});

test("VM-only actions are a subset of all actions", () => {
  for (const a of QEMU_ONLY_ACTIONS) assert.ok(GUEST_ACTIONS.includes(a));
  assert.deepEqual([...QEMU_ONLY_ACTIONS].sort(), ["reset", "resume", "suspend"]);
});
