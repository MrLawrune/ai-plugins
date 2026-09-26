import { test } from "node:test";
import assert from "node:assert/strict";
import type { GuestRef } from "../types.ts";
import { ProxmoxActions, type WriteClient } from "./actions.ts";

type Call = { method: string; path: string; params?: Record<string, unknown> };
function recorder(reply: (c: Call) => unknown = () => "UPID:pve1:1:2:3:x:201:u@pve!t:") {
  const calls: Call[] = [];
  const mk = (method: string) => async <T>(path: string, params?: Record<string, unknown>): Promise<T> => {
    const c = { method, path, params };
    calls.push(c);
    return reply(c) as T;
  };
  const client = { get: mk("GET"), post: mk("POST"), put: mk("PUT"), delete: mk("DELETE") } as unknown as WriteClient;
  return { client, calls };
}
const ct: GuestRef = { kind: "guest", node: "pve1", vmid: 201, type: "lxc" };
const vm: GuestRef = { kind: "guest", node: "pve1", vmid: 101, type: "qemu" };
const sig = new AbortController().signal;

test("power actions POST to status endpoints and return the UPID", async () => {
  const { client, calls } = recorder();
  const a = new ProxmoxActions(client, client, "main");
  for (const kind of ["start", "shutdown", "reboot", "stop"] as const) assert.deepEqual(await a.run(kind, ct, {}, sig), { kind: "task", upid: "UPID:pve1:1:2:3:x:201:u@pve!t:" });
  for (const kind of ["reset", "suspend", "resume"] as const) await a.run(kind, vm, {}, sig);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "POST /nodes/pve1/lxc/201/status/start", "POST /nodes/pve1/lxc/201/status/shutdown", "POST /nodes/pve1/lxc/201/status/reboot", "POST /nodes/pve1/lxc/201/status/stop",
    "POST /nodes/pve1/qemu/101/status/reset", "POST /nodes/pve1/qemu/101/status/suspend", "POST /nodes/pve1/qemu/101/status/resume",
  ]);
});

test("snapshot actions map to snapshot endpoints; vmstate only for VMs", async () => {
  const { client, calls } = recorder();
  const a = new ProxmoxActions(client, client, "main");
  await a.run("snapshot.create", ct, { snapname: "pre", description: "before", vmstate: true }, sig);
  await a.run("snapshot.create", vm, { snapname: "pre", vmstate: true }, sig);
  await a.run("snapshot.rollback", ct, { snapname: "pre-x" }, sig);
  await a.run("snapshot.delete", vm, { snapname: "pre" }, sig);
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.params ?? null]), [
    ["POST", "/nodes/pve1/lxc/201/snapshot", { snapname: "pre", description: "before" }],
    ["POST", "/nodes/pve1/qemu/101/snapshot", { snapname: "pre", vmstate: 1 }],
    ["POST", "/nodes/pve1/lxc/201/snapshot/pre-x/rollback", null],
    ["DELETE", "/nodes/pve1/qemu/101/snapshot/pre", null],
  ]);
});

test("protect/unprotect PUT only the protection key and finish synchronously", async () => {
  const { client, calls } = recorder(() => null);
  const a = new ProxmoxActions(client, client, "main");
  assert.deepEqual(await a.run("protect", vm, {}, sig), { kind: "done" });
  assert.deepEqual(await a.run("unprotect", ct, {}, sig), { kind: "done" });
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.params]), [["PUT", "/nodes/pve1/qemu/101/config", { protection: 1 }], ["PUT", "/nodes/pve1/lxc/201/config", { protection: 0 }]]);
});

test("privileges read /access/permissions for the guest path through the action client", async () => {
  const reader = recorder(() => { throw new Error("reader must not be used"); });
  const writer = recorder(() => ({ "/vms/201": { "VM.PowerMgmt": 1, "VM.Audit": 0 } }));
  const a = new ProxmoxActions(reader.client, writer.client, "action");
  assert.deepEqual([...await a.privileges(ct, sig)].sort(), ["VM.Audit", "VM.PowerMgmt"]);
  assert.deepEqual(writer.calls[0], { method: "GET", path: "/access/permissions", params: { path: "/vms/201" } });
});

test("capabilities report each distinct credential at /vms", async () => {
  const reader = recorder(() => ({ "/vms": { "VM.Audit": 1 } }));
  const writer = recorder(() => ({ "/vms": { "VM.PowerMgmt": 1 } }));
  const both = await new ProxmoxActions(reader.client, writer.client, "action").capabilities(sig);
  assert.deepEqual(both.map((c) => [c.credential, [...c.privileges]]), [["main", ["VM.Audit"]], ["action", ["VM.PowerMgmt"]]]);
  const one = await new ProxmoxActions(reader.client, reader.client, "main").capabilities(sig);
  assert.deepEqual(one.map((c) => c.credential), ["main"]);
});

test("facts combine state, protection, and snapshot names (without 'current')", async () => {
  const { client } = recorder((c) => c.path.endsWith("/status/current") ? { status: "running" }
    : c.path.endsWith("/config") ? { protection: 1 }
    : [{ name: "pre" }, { name: "current", parent: "pre" }]);
  assert.deepEqual(await new ProxmoxActions(client, client, "main").facts(ct, sig), { state: "running", protected: true, snapshots: ["pre"] });
});

test("facts report a VM paused in RAM (status running, qmpstatus paused) as paused", async () => {
  const { client } = recorder((c) => c.path.endsWith("/status/current") ? { status: "running", qmpstatus: "paused" }
    : c.path.endsWith("/config") ? {} : []);
  assert.equal((await new ProxmoxActions(client, client, "main").facts(vm, sig)).state, "paused");
});

test("task status, log, and abort address the node's task by encoded UPID", async () => {
  const upid = "UPID:pve1:0000ABCD:00001234:66F00000:vzstop:201:u@pve!t:";
  const { client, calls } = recorder((c) => c.path.endsWith("/status") ? { status: "stopped", exitstatus: "OK" } : c.path.endsWith("/log") ? [{ n: 1, t: "stopping" }, { n: 2, t: "TASK OK" }] : null);
  const a = new ProxmoxActions(client, client, "main");
  assert.deepEqual(await a.taskStatus("pve1", upid, sig), { running: false, exitstatus: "OK" });
  assert.deepEqual(await a.taskLog("pve1", upid, 0, 500, sig), ["stopping", "TASK OK"]);
  await a.abortTask("pve1", upid, sig);
  const enc = encodeURIComponent(upid);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`GET /nodes/pve1/tasks/${enc}/status`, `GET /nodes/pve1/tasks/${enc}/log`, `DELETE /nodes/pve1/tasks/${enc}`]);
  assert.deepEqual(calls[1]!.params, { start: 0, limit: 500 });
});
