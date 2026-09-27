import { test } from "node:test";
import assert from "node:assert/strict";
import { countsLine, parsePlaybookAttrs, whenText } from "./directive-attrs.ts";

test("accepts well-formed attributes only", () => {
  assert.deepEqual(parsePlaybookAttrs({ env: "lab", file: "site.yml" }), { env: "lab", file: "site.yml", play: null, run: null });
  assert.deepEqual(parsePlaybookAttrs({ env: "lab", file: "web/site.yml", play: "p1", run: "run_abcdef" })?.play, "p1");
  const bad: Record<string, string>[] = [{ env: "Lab", file: "x.yml" }, { env: "lab", file: "../x.yml" }, { env: "lab", file: "/etc/hosts" }, { env: "lab" }, { file: "x.yml" }, { env: "lab", file: "x.yml", play: "t0" }, { env: "lab", file: "x.yml", run: "run" }];
  for (const a of bad) assert.equal(parsePlaybookAttrs(a), null, JSON.stringify(a));
});

test("whenText renders simple conditions plainly, others verbatim", () => {
  assert.equal(whenText("ufw_present is defined"), "only if ufw_present is defined");
  assert.equal(whenText("ansible_os_family == 'Debian'"), "only if ansible_os_family == 'Debian'");
  assert.equal(whenText("x is not defined"), "only if x is not defined");
  assert.equal(whenText("a != b"), "only if a != b");
  assert.equal(whenText("a == 1 and b == 2"), "when: a == 1 and b == 2");
  assert.equal(whenText("a | bool"), "when: a | bool");
  assert.equal(whenText("a in b"), "when: a in b");
});

test("countsLine pluralises and omits empty parts", () => {
  assert.equal(countsLine({ plays: 2, steps: 9, handlers: 1 }, ["webservers", "dbservers"]), "2 plays · webservers, dbservers · 9 steps · 1 handler");
  assert.equal(countsLine({ plays: 1, steps: 1, handlers: 0 }, []), "1 play · 1 step");
});
