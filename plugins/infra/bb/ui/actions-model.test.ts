import { test } from "node:test";
import assert from "node:assert/strict";
import { canSubmit, menuActions, primaryAction, progressText } from "./actions-model.ts";
import type { ActionDto } from "../schemas.ts";

const row = (over: Partial<ActionDto>): ActionDto => ({
  id: "a1", envId: "e", connectionId: "c", target: "lab/pve1/201", guestName: "proxy", action: "stop", params: {}, confirm: "dialog",
  sourceSurface: "page", sourceThreadId: null, credential: "action", upid: "UPID:x", status: "running", exitstatus: null, error: null,
  lastLine: null, requestedAt: 0, endedAt: null, ...over,
});

test("the primary button follows the guest state", () => {
  assert.equal(primaryAction("lxc", "stopped"), "start");
  assert.equal(primaryAction("lxc", "running"), "shutdown");
  assert.equal(primaryAction("qemu", "paused"), "resume");
  assert.equal(primaryAction("lxc", "unknown"), null);
});

test("menus hide VM-only actions for containers", () => {
  assert.ok(menuActions("qemu").includes("reset"));
  assert.ok(!menuActions("lxc").includes("reset"));
  assert.ok(!menuActions("lxc").includes("snapshot.rollback"), "rollback/delete live on snapshot rows, not the menu");
});

test("typed confirmation gates the submit button", () => {
  assert.equal(canSubmit("dialog", null, ""), true);
  assert.equal(canSubmit("typed", "proxy", "prox"), false);
  assert.equal(canSubmit("typed", "proxy", " proxy "), true);
});

test("progress text for each outcome", () => {
  assert.deepEqual(progressText(row({})), { tone: "loading", text: "Stopping proxy…" });
  assert.deepEqual(progressText(row({ status: "ok" })), { tone: "success", text: "Stopped proxy" });
  assert.deepEqual(progressText(row({ status: "failed", exitstatus: "command failed" })), { tone: "error", text: "Stop failed on proxy: command failed" });
  assert.deepEqual(progressText(row({ status: "unknown", endedAt: null })), { tone: "loading", text: "Stopping proxy… (waiting for Proxmox)" });
  assert.equal(progressText(row({ status: "unknown", endedAt: 5 })).tone, "warning");
  assert.deepEqual(progressText(row({ action: "snapshot.create", params: { snapname: "pre" }, status: "ok" })), { tone: "success", text: "Took snapshot pre of proxy" });
});
