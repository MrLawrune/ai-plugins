import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTarget, isSafeRelativePath, parseRunRef, parseTarget } from "./targets.ts";

test("parses env, playbook, and node targets", () => {
  assert.deepEqual(parseTarget("lab"), { env: "lab" });
  assert.deepEqual(parseTarget("lab/site.yml"), { env: "lab", path: "site.yml" });
  assert.deepEqual(parseTarget("lab/web/site.yml#p0/t1"), { env: "lab", path: "web/site.yml", node: "p0/t1" });
  assert.deepEqual(parseTarget("lab/site.yml#p1/rcommon"), { env: "lab", path: "site.yml", node: "p1/rcommon" });
});
test("rejects unsafe or malformed targets", () => {
  for (const s of ["Lab", "lab/../x.yml", "lab//x.yml", "lab/x.yml#q0", "lab/x.yml#p0/", "lab/x.yml#p0/t1/x", "/etc", "lab/./a.yml", "lab#p0", "lab/x.yml#p0#p1"]) assert.equal(parseTarget(s), null, s);
});
test("round-trips", () => {
  for (const s of ["lab", "lab/site.yml", "lab/a/b.yaml#p0/t1/t0", "lab/a.yml#p0/h2"]) assert.equal(formatTarget(parseTarget(s)!), s);
});
test("run refs", () => {
  assert.deepEqual(parseRunRef("run_01HZXY"), { runId: "run_01HZXY" });
  assert.deepEqual(parseRunRef("run_01HZXY/web-02/p0/t1"), { runId: "run_01HZXY", host: "web-02", node: "p0/t1" });
  assert.equal(parseRunRef("run_/x"), null);
  assert.equal(parseRunRef("run_abc"), null);
  assert.equal(parseRunRef("run_01HZXY/-bad/p0/t1"), null);
  assert.equal(parseRunRef("run_01HZXY/web-02/q0"), null);
  assert.equal(parseRunRef("run_01HZXY/web-02"), null);
});
test("safe relative paths", () => {
  assert.ok(isSafeRelativePath("site.yml") && isSafeRelativePath("a/b/c.yaml"));
  assert.ok(!isSafeRelativePath("/x") && !isSafeRelativePath("../x") && !isSafeRelativePath("a/../x") && !isSafeRelativePath("a\\b") && !isSafeRelativePath(""));
});
