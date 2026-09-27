import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaybook } from "./parser/parse.ts";
import { renderContext } from "./context.ts";
import { loadText } from "../test-util.ts";
const content = loadText("playbooks/site.yml"); const summary = parsePlaybook("lab", "site.yml", content);
const env = { id: "e", slug: "lab", name: "Lab", kind: "lab", color: "#0f0", rules: "Always run check mode first.\n".repeat(40), controlHost: "control", hostId: null, repoPath: "/srv/example", inventoryRoot: "/srv/example/inventories", runnerKind: "ssh", agentApproval: "form", defaultCheck: true, infraEnvSlug: null, enabled: true, createdAt: 0 } as const;

test("task context has env, rules excerpt, step, yaml excerpt, vars, and the how-to footer", () => {
  const out = renderContext({ target: { env: "lab", path: "site.yml", node: "p0/t1" }, env, head: "3f2a1c9", summary, content, run: null, budget: 4096 });
  assert.ok(out.startsWith("## Playbooks context — lab/site.yml#p0/t1"));
  assert.ok(out.split("\n").includes("env: lab (lab) · control host: control · repo: /srv/example @ 3f2a1c9"));
  assert.ok( out.includes("rules: Always run check mode first.") && out.includes("(see `bb playbooks rules lab`)"));
  assert.ok(out.includes('step: 2 "Write nginx site config" · ansible.builtin.template · notify: reload nginx'));
  assert.ok(/\n\d+ \| +- name: Write nginx site config\n/.test(out) && out.includes("play vars: nginx_conf_path, site_domain"));
  assert.ok(out.trimEnd().endsWith("paste the ::playbook line"));
  assert.ok(Buffer.byteLength(out) <= 4096);
});
test("budget drops sections from the bottom, never mid-line", () => {
  const out = renderContext({ target: { env: "lab", path: "site.yml", node: "p0/t1" }, env, head: null, summary, content, run: null, budget: 500 });
  assert.ok(Buffer.byteLength(out) <= 500 && out.split("\n").every((l) => !l.endsWith("…") || l.startsWith("… (")));
  assert.ok(out.startsWith("## Playbooks context") && out.trimEnd().endsWith("paste the ::playbook line"));
});
test("investigation context includes failure and instructions", () => {
  const out = renderContext({ target: { runId: "run_x", host: "web-02", node: "p0/t1" }, env, head: null, summary, content, run: null, failure: { host: "web-02", nodeId: "p0/t1", msg: "Could not find or access 'templates/site.conf.j2'", res: '{"msg":"x"}', stdout: "fatal: [web-02]: FAILED!", diff: null }, budget: 12288 });
  assert.ok(out.includes("failed host: web-02") && out.includes("Could not find or access") && out.includes("diagnose only"));
});
test("env line omits the head when unknown", () => {
  const out = renderContext({ target: { env: "lab" }, env, head: null, summary: null, content: null, run: null, budget: 4096 });
  assert.ok(out.split("\n").includes("env: lab (lab) · control host: control · repo: /srv/example"));
});
test("last run lists per-host cells and the first failure message per failed host", () => {
  const run = { runId: "run_x", status: "failed", plays: [{ id: "p0", name: "Web servers", tasks: [{ nodeId: "p0/t1", name: "Write nginx site config", cells: { "web-01": "ok", "web-02": "failed" } }] }] } as never;
  const out = renderContext({ target: { env: "lab", path: "site.yml", node: "p0/t1" }, env, head: null, summary, content, run, cellMessages: { "web-02": "template not found" }, budget: 4096 });
  assert.ok(out.split("\n").includes('last run: run_x failed · web-01 ok, web-02 failed · web-02 ✗ "template not found"'));
});
test("the instruction survives the budget cut; header, footer, and instruction always stay", () => {
  const instruction = "x".repeat(4000);
  const out = renderContext({ target: { env: "lab", path: "site.yml", node: "p0/t1" }, env, head: null, summary, content, run: null, instruction, budget: 4200 });
  assert.ok(Buffer.byteLength(out) <= 4200);
  assert.ok(out.includes(`instruction: ${instruction}`));
  assert.ok(out.startsWith("## Playbooks context") && out.trimEnd().endsWith("paste the ::playbook line"));
  const huge = renderContext({ target: { env: "lab" }, env, head: null, summary: null, content: null, run: null, instruction: "y".repeat(9000), budget: 8192 });
  assert.ok(Buffer.byteLength(huge) <= 8192);
  assert.ok(huge.includes("instruction: " + "y".repeat(4095) + "…"));
});
test("whole-run investigations say how many failure blocks the budget dropped", () => {
  const failures = Array.from({ length: 6 }, (_, i) => ({ host: `web-0${i}`, nodeId: "p0/t1", msg: "boom", res: "r".repeat(1500), stdout: "", diff: null }));
  const out = renderContext({ target: { runId: "run_x" }, env, head: null, summary, content, run: null, failures, budget: 5000 });
  assert.ok(Buffer.byteLength(out) <= 5000);
  assert.match(out, /… \d more failures? omitted/);
  assert.ok(out.trimEnd().endsWith("summarise the cause in one line first."));
  const all = renderContext({ target: { runId: "run_x" }, env, head: null, summary, content, run: null, failures: failures.slice(0, 2), budget: 12288 });
  assert.ok(!all.includes("omitted"));
});
