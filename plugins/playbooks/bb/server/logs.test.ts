import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneLogs } from "./logs.ts";

test("pruneLogs removes old files and emptied directories, keeps recent ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "pb-logs-"));
  mkdirSync(join(root, "thr_old")); mkdirSync(join(root, "thr_new"));
  writeFileSync(join(root, "thr_old", "run_a.log"), "x"); writeFileSync(join(root, "thr_new", "run_b.log"), "y");
  const old = new Date(Date.now() - 100 * 86_400_000);
  utimesSync(join(root, "thr_old", "run_a.log"), old, old);
  assert.equal(await pruneLogs(root, Date.now() - 90 * 86_400_000), 1);
  assert.deepEqual(readdirSync(root), ["thr_new"]);
  assert.equal(await pruneLogs(join(root, "missing"), Date.now()), 0);
});
