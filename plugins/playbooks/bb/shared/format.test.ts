import assert from "node:assert/strict";
import { test } from "node:test";
import { age, elapsed, glyph, l0Line } from "./format.ts";
import type { RunView } from "./types.ts";

const task = (name: string, state: "ok" | "running" | "pending") => ({ nodeId: null, name, cells: { "web-01": state } });

function view(over: Partial<RunView> = {}): RunView {
  return {
    runId: "run_abc123", status: "running", playbook: "site.yml",
    env: { slug: "lab", name: "lab", kind: "lab", color: "#22c55e" },
    plays: [
      { id: "p0", name: "a", tasks: [task("t0", "ok"), task("t1", "ok"), task("t2", "ok"), task("t3", "ok")] },
      { id: "p1", name: "b", tasks: [task("t4", "ok"), task("t5", "running"), task("t6", "pending"), task("t7", "pending"), task("t8", "pending")] },
    ],
    hosts: ["web-01"], counters: { ok: 0, changed: 0, failed: 0, unreachable: 0, skipped: 0 },
    recap: null, investigations: [], startedAt: 0, endedAt: null, lastLine: null, ...over,
  };
}

test("glyph maps cell and run states", () => {
  assert.equal(glyph("changed"), "~");
  assert.equal(glyph("ok"), "✓");
  assert.equal(glyph("failed"), "✗");
  assert.equal(glyph("unreachable"), "!");
  assert.equal(glyph("skipped"), "–");
  assert.equal(glyph("running"), "◐");
  assert.equal(glyph("pending"), "·");
});

test("l0Line for a running view", () => {
  assert.equal(
    l0Line(view({ plays: [
      { id: "p0", name: "a", tasks: [task("t0", "ok"), task("t1", "ok"), task("t2", "running")] },
      { id: "p1", name: "b", tasks: [1, 2, 3, 4, 5, 6].map((i) => task(`u${i}`, "pending")) },
    ] }), 1000, { inventory: "inventories/staging.yml", check: true }),
    "◐ Running  ◆lab site.yml → inventories/staging.yml (check) · play 1/2 · task 3/9",
  );
});

test("l0Line without meta or plays", () => {
  assert.equal(l0Line(view({ status: "success", plays: [] }), 0), "✓ Success  ◆lab site.yml");
});

test("age and elapsed", () => {
  assert.equal(age(4_000), "4s");
  assert.equal(age(125_000), "2m");
  assert.equal(age(3 * 3_600_000), "3h");
  assert.equal(age(2 * 86_400_000), "2d");
  assert.equal(elapsed(0, 65_000, 0), "1m 5s");
  assert.equal(elapsed(1000, null, 8000), "7s");
  assert.equal(elapsed(null, null, 8000), "–");
});
