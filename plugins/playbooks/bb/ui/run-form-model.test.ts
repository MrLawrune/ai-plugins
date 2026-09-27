import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDisabledReason, fromPayload, toSpec, validate, type FormState } from "./run-form-model.ts";
import { PROD_APPLY_REASON } from "../server/policy.ts";

const spec = { inventory: "inv/hosts", limit: "", tags: [], skipTags: [], extraVars: {}, credRefId: null, check: true, diff: true, verbosity: 0 as const, branch: null };
const open = { applyAllowed: true, applyNeedsTyped: false, phrase: null };
const base = (over: Partial<FormState> = {}): FormState => ({
  inventory: "inv/hosts", limit: "", tags: "", skipTags: "", extraVars: [], credRefId: null, check: true, verbosity: 0, branch: null, typed: "", ...over,
});

test("validate rejects extra var key 1abc and long limit", () => {
  assert.ok(validate(base({ extraVars: [{ key: "1abc", value: "x" }] })).extraVars);
  assert.ok(validate(base({ limit: "x".repeat(201) })).limit);
  assert.deepEqual(validate(base({ extraVars: [{ key: "ok_1", value: "x" }] })), {});
});

test("toSpec parses JSON-looking values, keeps plain strings, splits tags", () => {
  const s = toSpec(base({ tags: " a, b ,,", extraVars: [{ key: "a", value: '{"a":1}' }, { key: "b", value: "hello" }, { key: "", value: "skip" }, { key: "n", value: "3" }] }));
  assert.deepEqual(s.extraVars, { a: { a: 1 }, b: "hello", n: 3 });
  assert.deepEqual(s.tags, ["a", "b"]);
  assert.equal(s.diff, s.check);
});

test("toSpec sends diff always for check mode", () => {
  assert.equal(toSpec(base({ check: true })).diff, true);
  assert.equal(toSpec(base({ check: false })).diff, false);
});

test("applyDisabledReason", () => {
  assert.equal(applyDisabledReason({ ...open, applyAllowed: false }, base({ check: false })), PROD_APPLY_REASON);
  assert.equal(applyDisabledReason({ ...open, applyAllowed: false }, base({ check: true })), null);
  const typed = { applyAllowed: true, applyNeedsTyped: true, phrase: "site.yml" };
  assert.ok(applyDisabledReason(typed, base({ check: false, typed: "nope" })));
  assert.equal(applyDisabledReason(typed, base({ check: false, typed: "site.yml" })), null);
  assert.equal(applyDisabledReason(typed, base({ check: true })), null);
});

test("fromPayload validates structurally", () => {
  const good = { env: { slug: "lab", name: "Lab", kind: "lab", color: "#112233" }, playbook: "site.yml", summaryLine: "s", spec, policy: open, inventories: ["inv/hosts"], credRefs: [{ id: "c", name: "n" }] };
  assert.ok(fromPayload(good));
  assert.equal(fromPayload(null), null);
  assert.equal(fromPayload({ ...good, spec: { ...spec, verbosity: 9 } }), null);
  assert.equal(fromPayload({ ...good, policy: {} }), null);
  assert.equal(fromPayload({ ...good, credRefs: [1] }), null);
});

test("applyDisabledReason prefers the server's reason", () => {
  assert.equal(applyDisabledReason({ ...open, applyAllowed: false, blockedReason: "environment lab is disabled" }, base({ check: false })), "environment lab is disabled");
});

test("typed confirmation with a null phrase falls back to the playbook name", () => {
  const p = { applyAllowed: true, applyNeedsTyped: true, phrase: null };
  assert.ok(applyDisabledReason(p, base({ check: false, typed: "" }), "site.yml"));
  assert.equal(applyDisabledReason(p, base({ check: false, typed: "site.yml" }), "site.yml"), null);
});

test("validate flags a value without a key", () => {
  assert.ok(validate(base({ extraVars: [{ key: " ", value: "x" }] })).extraVars);
  assert.deepEqual(validate(base({ extraVars: [{ key: "", value: "" }] })), {});
});

test("custom inventory must be a safe relative path and reaches the spec", () => {
  assert.equal(toSpec(base({ inventory: "custom/hosts.ini" })).inventory, "custom/hosts.ini");
  assert.deepEqual(validate(base({ inventory: "custom/hosts.ini" })), {});
  assert.ok(validate(base({ inventory: "/etc/hosts" })).inventory);
  assert.ok(validate(base({ inventory: "../x" })).inventory);
  assert.deepEqual(validate(base({ inventory: "" })), {});
});
