import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memDb } from "../test-util.ts";
import { writeExport } from "./export.ts";
import { Pins } from "./pins.ts";
import { Store } from "./store.ts";

test("unpinned or unknown threads get no instructions", () => {
  const pins = new Pins(new Store(memDb()), () => 1);
  assert.equal(pins.instructions(undefined, () => "x"), null);
  assert.equal(pins.instructions("thr_a", () => "x"), null);
});

test("pinned threads get a header plus rendered cards, capped at 4096 chars", () => {
  const pins = new Pins(new Store(memDb()), () => 1);
  pins.set("thr_a", Array.from({ length: 50 }, (_, i) => `homelab/pve1/${100 + i}`), true);
  const text = pins.instructions("thr_a", (pin) => pin.targets.map((t) => `${t}\n${"x".repeat(200)}`).join("\n"))!;
  assert.ok(text.startsWith("Infra context pinned to this thread"));
  assert.ok(text.length <= 4096);
});

test("pins persist through the store and clear", () => {
  const store = new Store(memDb());
  new Pins(store, () => 5).set("thr_a", ["homelab"], false);
  const pins = new Pins(store, () => 6);
  pins.load();
  assert.deepEqual(pins.get("thr_a"), { threadId: "thr_a", targets: ["homelab"], rulesIncluded: false, pinnedAt: 5 });
  pins.clear("thr_a");
  assert.equal(pins.get("thr_a"), null);
  assert.deepEqual(store.listPins(), []);
});

test("export writes registry and rules atomically into a new directory", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "infra-")), "nested", "dir");
  await writeExport(dir, "homelab", "# Homelab\n", "Use Podman\n");
  assert.equal(await readFile(join(dir, "homelab-registry.md"), "utf8"), "# Homelab\n");
  assert.equal(await readFile(join(dir, "homelab-rules.md"), "utf8"), "Use Podman\n");
  assert.deepEqual((await readdir(dir)).sort(), ["homelab-registry.md", "homelab-rules.md"]);
});
