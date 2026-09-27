import { test } from "node:test";
import assert from "node:assert/strict";
import { plainLine } from "./verbs.ts";
const a = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

test("verb table", () => {
  assert.equal(plainLine("ansible.builtin.apt", a({ name: '["nginx","certbot"]', state: "present" }), null, []), "Install packages: nginx, certbot");
  assert.equal(plainLine("apt", a({ name: "nginx", state: "absent" }), null, []), "Remove packages: nginx");
  assert.equal(plainLine("ansible.builtin.service", a({ name: "nginx", state: "started", enabled: "true" }), null, []), "Enable and start nginx");
  assert.equal(plainLine("systemd", a({ name: "nginx", state: "restarted" }), null, []), "Restart nginx");
  assert.equal(plainLine("ansible.builtin.template", a({ src: "a.j2", dest: "/etc/x" }), null, []), "Write /etc/x");
  assert.equal(plainLine("file", a({ path: "/srv/app", state: "directory" }), null, []), "Create directory /srv/app");
  assert.equal(plainLine("ansible.builtin.command", a({ _raw: "ufw allow 80,443/tcp" }), null, []), "Run: ufw allow 80,443/tcp");
  assert.equal(plainLine("debug", a({ msg: "hi" }), null, []), "Print hi");
  assert.equal(plainLine("community.postgresql.postgresql_db", a({ name: "app" }), null, []), "postgresql_db app");
  assert.equal(plainLine("apt", a({ name: "nginx" }), "Install web server", ["reload nginx"]), "Install web server → reload nginx when changed");
  assert.equal(plainLine("shell", a({ _raw: "x".repeat(100) }), null, []).length, "Run: ".length + 61);
});
