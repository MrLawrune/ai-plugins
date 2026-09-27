import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaybook } from "../server/parser/parse.ts";
import { loadText } from "../test-util.ts";
import { resolveNode } from "./node-resolver.ts";

const site = parsePlaybook("lab", "site.yml", loadText("playbooks/site.yml"));
const blocks = parsePlaybook("lab", "blocks.yml", loadText("playbooks/blocks.yml"));

test("task ids resolve to the task with its play", () => {
  const r = resolveNode(site, "p0/t1");
  assert.equal(r?.kind, "task"); assert.equal(r?.kind === "task" && r.t.name, "Write nginx site config"); assert.equal(r?.play.id, "p0");
});
test("nested block children resolve", () => {
  const r = resolveNode(blocks, "p0/t0/t1");
  assert.equal(r?.kind, "task"); assert.equal(r?.kind === "task" && r.t.name, "Sync application code");
});
test("handler ids resolve to handlers, not the role fallback", () => {
  const r = resolveNode(site, "p0/h0");
  assert.equal(r?.kind, "handler"); assert.equal(r?.kind === "handler" && r.t.name, "reload nginx"); assert.equal(r?.play.id, "p0");
});
test("play and role ids resolve", () => {
  assert.deepEqual(resolveNode(site, "p0")?.kind, "play");
  const r = resolveNode(site, "p0/rcommon");
  assert.equal(r?.kind, "role"); assert.equal(r?.kind === "role" && r.name, "common");
});
test("unknown ids resolve to null (never a role card)", () => {
  for (const id of ["p0/x", "p0/h9", "p0/rnope", "p7", "hosts:webservers", "", "p0/t0/t9"]) assert.equal(resolveNode(site, id), null, id);
});
