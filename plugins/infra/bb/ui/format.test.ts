import { test } from "node:test";
import assert from "node:assert/strict";
import { healthLabel, kindColor, PROD_COLOR, slugify, stateTone } from "./format.ts";

test("prod always uses the reserved color; others keep theirs", () => {
  assert.equal(kindColor("prod", "#22c55e"), PROD_COLOR);
  assert.equal(kindColor("lab", "#22c55e"), "#22c55e");
  assert.equal(kindColor("lab", "not-a-color"), "#64748b");
});

test("state tones", () => {
  assert.deepEqual([stateTone("running"), stateTone("stopped"), stateTone("paused"), stateTone("unknown")], ["ok", "off", "warn", "warn"]);
});

test("health labels read as plain language", () => {
  assert.equal(healthLabel("ok", null, 0), "Healthy");
  assert.equal(healthLabel("unreachable", 1_000, 43_000), "Unreachable · stale 42s");
  assert.equal(healthLabel("tls-mismatch", null, 0), "Certificate changed");
});

test("slugify derives a valid slug from a display name", () => {
  assert.deepEqual([slugify("Acme Prod (EU)"), slugify("  Home  Lab "), slugify("!!!")], ["acme-prod-eu", "home-lab", "env"]);
});
