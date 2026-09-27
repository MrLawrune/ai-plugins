import { test } from "node:test";
import assert from "node:assert/strict";
import { panelParams } from "./panel-params.ts";

test("root for empty or junk params", () => {
  for (const p of [null, undefined, {}, "x", 4, [], { target: "../" }, { target: "lab" }, { target: "lab/../x.yml" }, { target: 3 }, { runId: "run" }, { runId: "run_abcdef/../x" }]) {
    assert.deepEqual(panelParams(p), { kind: "root" }, JSON.stringify(p));
  }
});

test("playbook params keep view null for auto", () => {
  assert.deepEqual(panelParams({ target: "lab/site.yml" }), { kind: "playbook", target: "lab/site.yml", view: null, run: false });
  assert.deepEqual(panelParams({ target: "lab/web/site.yml#p0/t1", view: "graph", run: true }), { kind: "playbook", target: "lab/web/site.yml#p0/t1", view: "graph", run: true });
  assert.equal((panelParams({ target: "lab/site.yml", view: "weird" }) as { view: unknown }).view, null);
});

test("run params", () => {
  assert.deepEqual(panelParams({ runId: "run_abcdef" }), { kind: "run", runId: "run_abcdef" });
});
