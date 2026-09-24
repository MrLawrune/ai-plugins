import { test } from "node:test";
import assert from "node:assert/strict";
import { findUv, run } from "./uv.ts";

test("findUv checks PATH, then ~/.local/bin, then ~/.cargo/bin", () => {
  const has = (set: string[]) => (p: string) => set.includes(p);
  assert.equal(findUv({ PATH: "/usr/bin:/opt/bin" }, "/h", has(["/opt/bin/uv"])), "/opt/bin/uv");
  assert.equal(findUv({ PATH: "/usr/bin" }, "/h", has(["/h/.local/bin/uv"])), "/h/.local/bin/uv");
  assert.equal(findUv({ PATH: "" }, "/h", has(["/h/.cargo/bin/uv"])), "/h/.cargo/bin/uv");
  assert.equal(findUv({ PATH: "/usr/bin" }, "/h", has([])), null);
});

test("run returns exit code and tail of output", async () => {
  const ok = await run(process.execPath, ["-e", "console.log('hi'); console.error('warn')"]);
  assert.equal(ok.code, 0);
  assert.match(ok.output, /hi[\s\S]*warn|warn[\s\S]*hi/);
  const bad = await run(process.execPath, ["-e", "process.exit(3)"]);
  assert.equal(bad.code, 3);
  const missing = await run("/nonexistent/binary", []);
  assert.equal(missing.code, -1);
});
