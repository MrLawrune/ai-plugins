import { test } from "node:test";
import assert from "node:assert/strict";
import { contextSize, fixInstruction, investigateToast, investigationLine, mentionLabel, parseErrorLabel, promptBytes, withInstruction } from "./dispatch-model.ts";

test("mentionLabel prefers the plain step text and falls back to the ref", () => {
  assert.equal(mentionLabel("lab/site.yml#p0/t1", "Write nginx site config"), "site.yml › Write nginx site config");
  assert.equal(mentionLabel("lab/site.yml#p0", "Web servers"), "site.yml › Web servers");
  assert.equal(mentionLabel("lab/site.yml"), "lab/site.yml");
  assert.equal(mentionLabel("lab"), "lab");
  assert.equal(mentionLabel("run_abc123/web-02/p0/t1"), "run_abc123/web-02/p0/t1");
  assert.equal(mentionLabel("lab/site.yml#p0/t1", "   "), "lab/site.yml#p0/t1");
  assert.equal(mentionLabel("lab/site.yml#p0/t1", "x".repeat(200)).length, 80 + "site.yml › ".length);
});

test("parse-error label and instruction carry the line and message, clipped", () => {
  const err = { line: 14, message: "bad indentation of a mapping entry" };
  assert.equal(parseErrorLabel("site.yml", err), "site.yml (parse error line 14: bad indentation of a mapping entry)");
  assert.equal(fixInstruction("site.yml", err), "Fix the YAML parse error in site.yml at line 14: bad indentation of a mapping entry");
  assert.ok(parseErrorLabel("site.yml", { line: 1, message: "m".repeat(500) }).length <= 140);
});

test("contextSize and promptBytes", () => {
  assert.equal(contextSize(512), "512 B");
  assert.equal(contextSize(1843), "1.8 KB");
  assert.equal(contextSize(12288), "12.0 KB");
  assert.equal(promptBytes("héllo"), 6);
  assert.equal(withInstruction("ctx", ""), "ctx");
  assert.equal(withInstruction("ctx", "  do it "), "ctx\ninstruction: do it");
});

test("investigate toast and line name the effective permission mode", () => {
  assert.equal(investigateToast("readonly"), "Investigating in a new thread (read-only)");
  assert.equal(investigateToast("accept-edits"), "Investigating in a new thread (accept-edits: approvals required)");
  assert.equal(investigationLine({ threadId: "thr_1", status: "running", summary: null, permissionMode: "accept-edits" }), "investigating in @thread:thr_1 (accept-edits)");
  assert.equal(investigationLine({ threadId: "thr_1", status: "idle", summary: "Cause\nmore", permissionMode: "readonly" }), "investigated in @thread:thr_1 (read-only): Cause");
  assert.equal(investigationLine({ threadId: "thr_1", status: "idle", summary: null, permissionMode: null }), "investigated in @thread:thr_1");
});
