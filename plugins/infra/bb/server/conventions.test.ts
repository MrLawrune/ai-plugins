import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conventions, CONVENTIONS_MAX_BYTES } from "./conventions.ts";

test("loads a conventions file, serves it synchronously after, and caps its size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conv-"));
  const small = join(dir, "AGENTS.md");
  const big = join(dir, "BIG.md");
  await writeFile(small, "# Conventions\nUse Podman.\n");
  await writeFile(big, "x".repeat(CONVENTIONS_MAX_BYTES + 500));
  let t = 0;
  const c = new Conventions(() => t);
  assert.equal(c.cached(small), null, "nothing until loaded");
  assert.equal(await c.load(small), "# Conventions\nUse Podman.\n");
  assert.equal(c.cached(small), "# Conventions\nUse Podman.\n");
  const b = await c.load(big);
  assert.ok(b.length < CONVENTIONS_MAX_BYTES + 100);
  assert.match(b, /truncated/);
  assert.match(await c.load(join(dir, "missing.md")), /^\(conventions file not readable: .*missing\.md\)$/);
  await writeFile(small, "changed\n");
  assert.equal(await c.load(small), "# Conventions\nUse Podman.\n", "cached within 30 s");
  t += 31_000;
  assert.equal(await c.load(small), "changed\n");
});
