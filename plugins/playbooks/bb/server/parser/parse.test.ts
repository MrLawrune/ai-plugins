import { test } from "node:test";
import assert from "node:assert/strict";
import { loadText } from "../../test-util.ts";
import { parsePlaybook } from "./parse.ts";

test("site.yml: plays, tasks, handlers, roles, vars", () => {
  const s = parsePlaybook("lab", "site.yml", loadText("playbooks/site.yml"));
  assert.equal(s.error, undefined);
  assert.equal(s.name, "Web servers");
  assert.deepEqual(s.counts, { plays: 2, steps: 7, handlers: 1, roles: 1 });
  assert.deepEqual(s.targets, ["webservers", "dbservers"]);
  const p0 = s.plays[0]!;
  assert.equal(p0.id, "p0"); assert.equal(p0.hosts, "webservers"); assert.equal(p0.become, true);
  assert.deepEqual(p0.vars, { keys: ["nginx_conf_path", "site_domain"], files: ["vars/web.yml"] });
  assert.deepEqual(p0.roles.map((r) => r.id), ["p0/rcommon"]);
  const t1 = p0.tasks[1]!;
  assert.equal(t1.id, "p0/t1"); assert.equal(t1.action, "ansible.builtin.template");
  assert.deepEqual(t1.notify, ["reload nginx"]); assert.deepEqual(t1.tags, ["config"]);
  assert.equal(t1.args.find((a) => a.key === "src")?.value, "templates/site.conf.j2");
  assert.equal(p0.tasks[3]!.name, null); assert.equal(p0.tasks[3]!.when, "ufw_installed.rc == 0");
  assert.equal(p0.handlers[0]!.id, "p0/h0");
  assert.equal(p0.tasks[3]!.plain, "Run: ufw allow 80,443/tcp");
  assert.equal(p0.tasks[1]!.plain, "Write nginx site config → reload nginx when changed");
  assert.equal(s.plays[1]!.serial, "1");
  assert.ok(s.warnings.some((w) => w.line === p0.tasks[3]!.line && /no name/.test(w.message)));
});
test("blocks.yml: block/rescue/always recurse with nested ids", () => {
  const s = parsePlaybook("lab", "blocks.yml", loadText("playbooks/blocks.yml"));
  const block = s.plays[0]!.tasks.find((t) => t.action === "block")!;
  assert.ok(block.children && block.children.block.length >= 1 && block.children.rescue.length >= 1);
  assert.equal(block.children!.block[0]!.id, `${block.id}/t0`);
  assert.ok(s.plays[0]!.tasks.some((t) => t.loop !== null) && s.plays[0]!.tasks.some((t) => t.delegateTo !== null));
});
test("roles-includes.yml: includes and pre/post tasks", () => {
  const s = parsePlaybook("lab", "roles-includes.yml", loadText("playbooks/roles-includes.yml"));
  const p = s.plays[0]!;
  assert.ok(p.preTasks.length >= 1 && p.postTasks.length >= 1);
  assert.ok(p.tasks.some((t) => t.include?.kind === "tasks") && p.tasks.some((t) => t.include?.kind === "role" && t.include.static));
});
test("import.yml: import_playbook entries", () => {
  const s = parsePlaybook("lab", "import.yml", loadText("playbooks/import.yml"));
  assert.deepEqual(s.imports.map((i) => i.path), ["site.yml"]);
  assert.equal(s.counts.plays, 1);
});
test("broken.yml: error with line, no plays, never throws", () => {
  const s = parsePlaybook("lab", "broken.yml", loadText("playbooks/broken.yml"));
  assert.equal(s.plays.length, 0); assert.equal(s.error?.line, 4);
  assert.equal(parsePlaybook("lab", "x.yml", "just: a map").error?.message, "a playbook must be a list of plays");
});
test("odd shapes never throw", () => {
  const nullTask = parsePlaybook("lab", "a.yml", "- hosts: all\n  tasks:\n    -\n");
  assert.equal(nullTask.error, undefined); assert.equal(nullTask.plays[0]!.tasks.length, 0);
  assert.ok(nullTask.warnings.some((w) => /task is not a mapping/.test(w.message)));
  const scalar = parsePlaybook("lab", "b.yml", "- hosts: all\n  tasks:\n    - foo\n");
  assert.equal(scalar.error, undefined); assert.ok(scalar.warnings.some((w) => /task is not a mapping/.test(w.message)));
  const inc = parsePlaybook("lab", "c.yml", "- hosts: all\n  tasks:\n    - include_tasks:\n        apply:\n          tags: [x]\n");
  assert.equal(inc.error, undefined); assert.equal(inc.plays[0]!.tasks[0]!.include?.target, "");
  const role = parsePlaybook("lab", "d.yml", "- hosts: all\n  roles:\n    - when: x\n");
  assert.equal(role.error, undefined); assert.equal(role.plays[0]!.roles.length, 1);
});
