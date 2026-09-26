import { test } from "node:test";
import assert from "node:assert/strict";
import { GUEST_ACTIONS, type ActionKind } from "../../shared/actions.ts";
import { decide, type PolicyInput } from "./policy.ts";

const ALL = new Set(["VM.PowerMgmt", "VM.Snapshot", "VM.Snapshot.Rollback", "VM.Config.Options"]);
const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  env: { kind: "lab", actionsEnabled: true },
  guest: { type: "lxc", state: "running", name: "proxy", vmid: 201, template: false },
  facts: { protected: false, snapshots: ["pre"] },
  privileges: ALL,
  action: "stop",
  params: {},
  ...over,
});
const reason = (i: PolicyInput) => { const r = decide(i); return r.allowed ? null : r.reason; };
const confirm = (i: PolicyInput) => { const r = decide(i); return r.allowed ? r.confirm : `rejected: ${r.reason}`; };

test("actions are off unless the environment enables them", () => {
  assert.match(reason(base({ env: { kind: "lab", actionsEnabled: false } }))!, /off for this environment/);
});

test("confirmation levels follow the spec table in a lab environment", () => {
  const cases: [ActionKind, RunStateLike, string][] = [
    ["start", "stopped", "none"], ["shutdown", "running", "dialog"], ["reboot", "running", "dialog"], ["stop", "running", "dialog"],
    ["snapshot.create", "running", "none"], ["snapshot.delete", "running", "dialog"], ["snapshot.rollback", "running", "typed"],
    ["protect", "running", "none"],
  ];
  for (const [action, state, want] of cases) {
    assert.equal(confirm(base({ action, guest: { type: "lxc", state, name: "proxy", vmid: 201, template: false }, params: { snapname: action === "snapshot.create" ? "new1" : "pre" } })), want, action);
  }
  assert.equal(confirm(base({ action: "unprotect", facts: { protected: true, snapshots: [] } })), "typed");
  for (const [action, state, want] of [["reset", "running", "dialog"], ["suspend", "running", "dialog"], ["resume", "paused", "none"]] as const) {
    assert.equal(confirm(base({ action, guest: { type: "qemu", state, name: "vm", vmid: 101, template: false } })), want, action);
  }
});

type RunStateLike = "running" | "stopped" | "paused";

test("every action on prod needs the typed guest name (VMID when unnamed)", () => {
  const prod = { kind: "prod" as const, actionsEnabled: true };
  const r = decide(base({ env: prod, action: "start", guest: { type: "lxc", state: "stopped", name: "proxy", vmid: 201, template: false } }));
  assert.deepEqual(r, { allowed: true, confirm: "typed", phrase: "proxy" });
  const unnamed = decide(base({ env: prod, action: "protect", guest: { type: "lxc", state: "running", name: "", vmid: 201, template: false } }));
  assert.deepEqual(unnamed, { allowed: true, confirm: "typed", phrase: "201" });
});

test("state preconditions", () => {
  assert.match(reason(base({ action: "start" }))!, /running/);
  assert.match(reason(base({ action: "stop", guest: { type: "lxc", state: "stopped", name: "proxy", vmid: 201, template: false } }))!, /stopped/);
  assert.match(reason(base({ action: "resume", guest: { type: "qemu", state: "running", name: "vm", vmid: 101, template: false } }))!, /paused/);
  assert.match(reason(base({ action: "protect", facts: { protected: true, snapshots: [] } }))!, /already protected/);
  assert.match(reason(base({ action: "unprotect" }))!, /not protected/);
});

test("VM-only actions and templates are rejected for containers and templates", () => {
  assert.match(reason(base({ action: "reset" }))!, /only.*VMs/);
  assert.match(reason(base({ guest: { type: "lxc", state: "running", name: "t", vmid: 9000, template: true } }))!, /Template/);
});

test("missing or unknown privileges reject with the privilege named", () => {
  assert.match(reason(base({ privileges: new Set(["VM.Audit"]) }))!, /VM\.PowerMgmt on \/vms\/201/);
  assert.match(reason(base({ privileges: null }))!, /privileges/);
  assert.equal(reason(base({ action: "snapshot.rollback", params: { snapname: "pre" }, privileges: new Set(["VM.Snapshot.Rollback"]) })), null);
  assert.match(reason(base({ action: "protect", privileges: new Set(["VM.PowerMgmt"]) }))!, /VM\.Config\.Options/);
});

test("snapshot parameters are validated unless in menu mode", () => {
  assert.match(reason(base({ action: "snapshot.create", params: { snapname: "current" } }))!, /reserved/);
  assert.match(reason(base({ action: "snapshot.create", params: { snapname: "pre" } }))!, /already exists/);
  assert.match(reason(base({ action: "snapshot.create", params: { snapname: "new1", vmstate: true } }))!, /RAM/);
  assert.match(reason(base({ action: "snapshot.rollback", params: { snapname: "gone" } }))!, /no longer exists/);
  assert.match(reason(base({ action: "snapshot.delete", params: {} }))!, /Pick a snapshot/);
  assert.equal(reason(base({ action: "snapshot.create", params: {}, forMenu: true })), null);
  assert.equal(reason(base({ action: "snapshot.rollback", params: {}, forMenu: true })), null);
  assert.match(reason(base({ action: "snapshot.rollback", params: {}, forMenu: true, facts: { protected: false, snapshots: [] } }))!, /no snapshots/);
});

test("every action kind is decidable", () => {
  for (const action of GUEST_ACTIONS) assert.ok(decide(base({ action, forMenu: true })) !== undefined);
});
