import { test } from "node:test";
import assert from "node:assert/strict";
import { PveError } from "../providers/proxmox/client.ts";
import { fakeActions, fakeProvider, guest, host, inv, serviceHarness } from "../../test-util.ts";

const src = { surface: "page" as const, threadId: null };
async function lab(actions = fakeActions(), opts: { kind?: "lab" | "prod"; enabled?: boolean } = {}) {
  const p = fakeProvider([inv([host("pve1")], [guest("pve1", 201, { name: "proxy" }), guest("pve1", 101, { name: "vm", type: "qemu" })])], {}, actions);
  return serviceHarness([{ slug: "lab", kind: opts.kind ?? "lab", actionsEnabled: opts.enabled ?? true, conns: { pve1: p } }]);
}

test("options list every action for the guest type with reasons", async () => {
  const h = await lab();
  const o = await h.actions.options("lab/pve1/201");
  assert.ok(o && o.enabled);
  const byAction = Object.fromEntries(o.options.map((x) => [x.action, x]));
  assert.equal(byAction.reset, undefined, "VM-only actions are not listed for containers");
  assert.equal(byAction.stop!.allowed, true);
  assert.equal(byAction.stop!.confirm, "dialog");
  assert.match(byAction.start!.reason!, /running/);
  assert.deepEqual(o.snapshots, ["pre"]);
  assert.equal(await h.actions.options("lab/pve1"), null);
});

test("options report disabled environments without calling Proxmox", async () => {
  const h = await lab(fakeActions({ facts: async () => { throw new Error("must not be called"); } }), { enabled: false });
  assert.deepEqual(await h.actions.options("lab/pve1/201"), { enabled: false });
});

test("prepare → execute runs the action once, audits it, and hands the task to the tracker", async () => {
  const fa = fakeActions();
  const h = await lab(fa);
  const p = await h.actions.prepare({ target: "lab/pve1/201", action: "stop", params: {}, source: src });
  assert.ok(p.allowed);
  assert.equal(p.confirm, "dialog");
  const r = await h.actions.execute({ token: p.token });
  assert.ok(r.ok);
  assert.deepEqual([r.action.status, r.action.upid, r.action.credential, r.action.guestName], ["running", "UPID:pve1:1:2:3:x:201:u@pve!t:", "action", "proxy"]);
  assert.equal(fa.calls.length, 1);
  assert.equal(h.started.length, 1);
  const again = await h.actions.execute({ token: p.token });
  assert.deepEqual(again, { ok: false, reason: "This confirmation expired. Start the action again." });
  assert.equal(fa.calls.length, 1, "a reused token never reaches Proxmox");
});

test("tokens expire after 60 seconds", async () => {
  const fa = fakeActions();
  const h = await lab(fa);
  const p = await h.actions.prepare({ target: "lab/pve1/201", action: "stop", params: {}, source: src });
  assert.ok(p.allowed);
  h.advance(60_001);
  assert.equal((await h.actions.execute({ token: p.token })).ok, false);
  assert.equal(fa.calls.length, 0);
});

test("a state change between prepare and execute is rejected and audited", async () => {
  let state: "running" | "stopped" = "running";
  const fa = fakeActions({ facts: async () => ({ state, protected: false, snapshots: [] }) });
  const h = await lab(fa);
  const p = await h.actions.prepare({ target: "lab/pve1/201", action: "stop", params: {}, source: src });
  assert.ok(p.allowed);
  state = "stopped";
  const r = await h.actions.execute({ token: p.token });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /changed|stopped/);
  assert.equal(fa.calls.length, 0);
  assert.equal(h.audits.at(-1)!.status, "rejected");
});

test("typed confirmation must match the guest name exactly", async () => {
  const fa = fakeActions({ facts: async () => ({ state: "running", protected: true, snapshots: [] }) });
  const h = await lab(fa);
  const p = await h.actions.prepare({ target: "lab/pve1/201", action: "unprotect", params: {}, source: src });
  assert.ok(p.allowed);
  assert.deepEqual([p.confirm, p.phrase], ["typed", "proxy"]);
  assert.equal((await h.actions.execute({ token: p.token, typed: "prox" })).ok, false);
  const p2 = await h.actions.prepare({ target: "lab/pve1/201", action: "unprotect", params: {}, source: src });
  assert.ok(p2.allowed);
  const r = await h.actions.execute({ token: p2.token, typed: "proxy" });
  assert.ok(r.ok);
  assert.deepEqual([r.action.status, r.action.endedAt !== null], ["ok", true]);
  assert.deepEqual(h.protections, [["lab/pve1/201", false]]);
});

test("policy rejections in prepare are audited and never reach Proxmox", async () => {
  const fa = fakeActions();
  const h = await lab(fa);
  const p = await h.actions.prepare({ target: "lab/pve1/201", action: "start", params: {}, source: { surface: "thread-panel", threadId: "thr_x" } });
  assert.equal(p.allowed, false);
  const row = h.audits.at(-1)!;
  assert.deepEqual([row.status, row.sourceSurface, row.sourceThreadId], ["rejected", "thread-panel", "thr_x"]);
  assert.equal(fa.calls.length, 0);
});

test("a 403 from Proxmox rejects with its reason and clears cached privileges", async () => {
  let privCalls = 0;
  const fa = fakeActions({
    privileges: async () => { privCalls++; return new Set(["VM.PowerMgmt"]); },
    run: async () => { throw new PveError("auth-failed", "Permission check failed (/vms/201, VM.PowerMgmt) (POST /x)", 403); },
  });
  const h = await lab(fa);
  const p = await h.actions.prepare({ target: "lab/pve1/201", action: "stop", params: {}, source: src });
  assert.ok(p.allowed);
  const r = await h.actions.execute({ token: p.token });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /Permission check failed/);
  assert.equal(h.audits.at(-1)!.status, "rejected");
  const before = privCalls;
  await h.actions.options("lab/pve1/201");
  assert.equal(privCalls, before + 1, "privileges are re-read after a 403");
});

test("an unreachable write records an unknown row for reconciliation", async () => {
  const fa = fakeActions({ run: async () => { throw new PveError("unreachable", "This operation was aborted", null); } });
  const h = await lab(fa);
  const p = await h.actions.prepare({ target: "lab/pve1/201", action: "stop", params: {}, source: src });
  assert.ok(p.allowed);
  const r = await h.actions.execute({ token: p.token });
  assert.ok(r.ok);
  assert.deepEqual([r.action.status, r.action.upid, r.action.endedAt], ["unknown", null, null]);
  assert.equal(h.started.at(-1)!.id, r.action.id);
});

test("other Proxmox errors record a failed row with the message", async () => {
  const fa = fakeActions({ run: async () => { throw new PveError("degraded", "CT 201 is locked (snapshot) (POST /x)", 500); } });
  const h = await lab(fa);
  const p = await h.actions.prepare({ target: "lab/pve1/201", action: "stop", params: {}, source: src });
  assert.ok(p.allowed);
  const r = await h.actions.execute({ token: p.token });
  assert.ok(r.ok);
  assert.deepEqual([r.action.status, r.action.error], ["failed", "CT 201 is locked (snapshot) (POST /x)"]);
});

test("abort only applies to running tracked tasks", async () => {
  let aborted = 0;
  const fa = fakeActions({ abortTask: async () => { aborted++; } });
  const h = await lab(fa);
  const p = await h.actions.prepare({ target: "lab/pve1/201", action: "stop", params: {}, source: src });
  assert.ok(p.allowed);
  const r = await h.actions.execute({ token: p.token });
  assert.ok(r.ok);
  assert.deepEqual(await h.actions.abort(r.action.id), { ok: true });
  assert.equal(aborted, 1);
  assert.deepEqual(h.abortsRequested, [r.action.id]);
  h.store.updateAction(r.action.id, { status: "ok", endedAt: h.now() });
  assert.equal((await h.actions.abort(r.action.id)).ok, false);
});

test("a failed abort does not mark the task as aborting", async () => {
  const h = await lab(fakeActions({ abortTask: async () => { throw new PveError("degraded", "task not found", 500); } }));
  const p = await h.actions.prepare({ target: "lab/pve1/201", action: "stop", params: {}, source: src });
  assert.ok(p.allowed);
  const r = await h.actions.execute({ token: p.token });
  assert.ok(r.ok);
  assert.equal((await h.actions.abort(r.action.id)).ok, false);
  assert.deepEqual(h.abortsRequested, []);
});

test("capabilities summarize each credential", async () => {
  const h = await lab();
  const id = h.store.listConnections()[0]!.id;
  assert.deepEqual(await h.actions.capabilities(id), [{ credential: "action", power: true, snapshots: false, rollback: false, protection: false }]);
});

test("a 403 while reading guest facts clears cached privileges", async () => {
  let privCalls = 0;
  let deny = false;
  const fa = fakeActions({
    privileges: async () => { privCalls++; return new Set(["VM.PowerMgmt"]); },
    facts: async () => {
      if (deny) throw new PveError("auth-failed", "Permission check failed (/vms/201, VM.Audit) (GET /x)", 403);
      return { state: "running", protected: false, snapshots: [] };
    },
  });
  const h = await lab(fa);
  await h.actions.options("lab/pve1/201");
  assert.equal(privCalls, 1);
  deny = true;
  const o = await h.actions.options("lab/pve1/201");
  assert.ok(o && o.enabled);
  assert.match(o.options[0]!.reason!, /Permission check failed/);
  deny = false;
  await h.actions.options("lab/pve1/201");
  assert.equal(privCalls, 2, "privileges are re-read after a 403 from facts");
});
