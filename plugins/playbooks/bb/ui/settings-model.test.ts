import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyEnvForm, failedTest, testResultView, slugify, validateEnvForm } from "./settings-model.ts";

test("slugify", () => {
  assert.equal(slugify("My Lab"), "my-lab");
  assert.equal(slugify("!!!"), "env");
});

test("validateEnvForm flags a bad slug", () => {
  const errs = validateEnvForm({ slug: "Lab" });
  assert.equal(errs.slug, "slug must be 1-32 lowercase letters, digits, or dashes");
});

test("validateEnvForm accepts a complete form and rejects missing paths", () => {
  const ok = { ...emptyEnvForm(), name: "Lab", slug: "lab", controlHost: "web-01", repoPath: "/srv/example" };
  assert.deepEqual(validateEnvForm(ok), {});
  const bad = validateEnvForm({ ...ok, repoPath: "srv", inventoryRoot: "x", controlHost: "local", name: " " });
  assert.ok(bad.repoPath && bad.inventoryRoot && bad.controlHost && bad.name);
});

test("empty form is ssh-only", () => {
  const f = emptyEnvForm();
  assert.equal(f.runnerKind, "ssh");
  assert.equal(f.hostId, null);
  assert.equal(f.infraEnvSlug, null);
});

test("kind change keeps a custom colour", async () => {
  const { colorForKindChange } = await import("./settings-model.ts");
  assert.equal(colorForKindChange("lab", "#123456", "dev"), "#123456");
  assert.equal(colorForKindChange("lab", "#22c55e", "dev"), "#3b82f6");
  assert.equal(colorForKindChange("lab", "#123456", "prod"), "#ef4444");
});

const health = { code: "degraded", message: "The repo is not a git checkout; HEAD is unknown.", ansible: "core 2.19", runner: "2.4.0", python3: "3.13", head: null, playbooks: 2 } as const;

test("testResultView shows the versions line and the message for a degraded result", () => {
  const v = testResultView(health);
  assert.equal(v.details, "ansible core 2.19 · runner 2.4.0 · python3 3.13 · repo HEAD ? · 2 playbooks");
  assert.equal(v.message, "degraded: The repo is not a git checkout; HEAD is unknown.");
});

test("testResultView has no message for ok, and failedTest is a full EnvHealth", () => {
  assert.equal(testResultView({ ...health, code: "ok", message: null, head: "3f2a1c9", playbooks: 1 }).message, null);
  assert.equal(testResultView(failedTest("boom")).message, "unreachable: boom");
});
