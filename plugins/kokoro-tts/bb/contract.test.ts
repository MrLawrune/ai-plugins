import { test } from "node:test";
import assert from "node:assert/strict";
import { configPatchSchema, DEFAULT_SETTINGS, configResponseSchema } from "./schemas.ts";

test("a coordinator patch and a runtime patch parse; a mixed one does not", () => {
  assert.ok(configPatchSchema.safeParse({ speed: 1.2 }).success);
  assert.ok(configPatchSchema.safeParse({ provider: "cpu" }).success);
  assert.equal(configPatchSchema.safeParse({ speed: 1.2, provider: "cpu" }).success, false);
  assert.equal(configPatchSchema.safeParse({ provider: "remote" }).success, false);
});
test("config response answers with no runtime", () => {
  assert.ok(configResponseSchema.safeParse({ config: DEFAULT_SETTINGS, muted: false, pause_other_audio_supported: false, runtime: null, note: null }).success);
});
