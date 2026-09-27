import { test } from "node:test";
import assert from "node:assert/strict";
import type { CredRefRow } from "./store.ts";
import type { EnvKind } from "../shared/constants.ts";
import { decide, wouldPrompt, type Decision, type RunSource } from "./policy.ts";

const spec = (o: Partial<{ check: boolean }> = {}) => ({ inventory: "i", limit: "", tags: [], skipTags: [], extraVars: {}, credRefId: null, check: true, diff: true, verbosity: 0 as const, branch: null, ...o });
const cli = { surface: "cli" as const, threadId: "thr_1" };
const PROD_MSG = "prod environments run in check mode only until a prod-apply template exists";

type RunOpts = { kind: EnvKind; surface: RunSource; check?: boolean; threadId?: string | null; approval?: string; noConfirm?: boolean; vaulted?: boolean; credRef?: CredRefRow | null };
function run(o: RunOpts): Decision {
  const threadId = o.threadId === undefined ? (o.surface === "cli" || o.surface === "tool" ? "thr_1" : null) : o.threadId;
  return decide({
    env: { kind: o.kind, agentApproval: o.approval ?? "form" }, spec: spec({ check: o.check ?? true }),
    source: { surface: o.surface, threadId }, noConfirm: o.noConfirm ?? false, vaultedInventory: o.vaulted ?? false, credRef: o.credRef ?? null,
  });
}
const confirmOf = (d: Decision): string => (d.allowed ? d.confirm : `refused: ${d.reason}`);

test("lab agent run shows the form unless approval is none and check", () => {
  assert.deepEqual(decide({ env: { kind: "lab", agentApproval: "form" }, spec: spec(), source: cli, noConfirm: false, vaultedInventory: false, credRef: null }), { allowed: true, confirm: "interaction", phrase: null });
  assert.deepEqual(decide({ env: { kind: "lab", agentApproval: "none" }, spec: spec(), source: cli, noConfirm: false, vaultedInventory: false, credRef: null }), { allowed: true, confirm: "none", phrase: null });
  assert.equal(confirmOf(run({ kind: "lab", surface: "cli", approval: "none", check: false })), "interaction");
  assert.equal(confirmOf(run({ kind: "dev", surface: "cli", approval: "none" })), "none");
  assert.equal(confirmOf(run({ kind: "dev", surface: "tool", approval: "none", check: false })), "interaction");
  assert.equal(confirmOf(run({ kind: "lab", surface: "tool" })), "interaction");
});
test("agent runs on staging/customer/prod always show the form; prod apply is rejected", () => {
  assert.equal(confirmOf(run({ kind: "staging", surface: "cli", approval: "none" })), "interaction");
  assert.equal(confirmOf(run({ kind: "staging", surface: "cli", check: false })), "interaction");
  assert.equal(confirmOf(run({ kind: "customer", surface: "tool", approval: "none" })), "interaction");
  assert.equal(confirmOf(run({ kind: "prod", surface: "cli" })), "interaction");
  assert.deepEqual(run({ kind: "prod", surface: "cli", check: false }), { allowed: false, reason: PROD_MSG });
  assert.deepEqual(run({ kind: "prod", surface: "tool", check: false, noConfirm: true }), { allowed: false, reason: PROD_MSG });
});
test("human runs: direct on lab, dialog on staging apply, typed on prod", () => {
  const panel = { surface: "panel" as const, threadId: null };
  assert.equal((decide({ env: { kind: "lab", agentApproval: "form" }, spec: spec({ check: false }), source: panel, noConfirm: false, vaultedInventory: false, credRef: null }) as { confirm: string }).confirm, "none");
  assert.equal((decide({ env: { kind: "staging", agentApproval: "form" }, spec: spec({ check: false }), source: panel, noConfirm: false, vaultedInventory: false, credRef: null }) as { confirm: string }).confirm, "dialog");
  assert.deepEqual(decide({ env: { kind: "prod", agentApproval: "form" }, spec: spec({ check: false }), source: panel, noConfirm: false, vaultedInventory: false, credRef: null }), { allowed: false, reason: PROD_MSG });
  assert.equal((decide({ env: { kind: "prod", agentApproval: "form" }, spec: spec(), source: panel, noConfirm: false, vaultedInventory: false, credRef: null }) as { confirm: string }).confirm, "none", "typed applies to prod apply only (spec §6.4)");
  assert.equal(confirmOf(run({ kind: "dev", surface: "card", check: false })), "none");
  assert.equal(confirmOf(run({ kind: "staging", surface: "page" })), "none");
  assert.equal(confirmOf(run({ kind: "customer", surface: "card", check: false })), "dialog");
  assert.equal(confirmOf(run({ kind: "other", surface: "page", check: false })), "dialog");
  assert.equal(confirmOf(run({ kind: "prod", surface: "card" })), "none");
  assert.equal(confirmOf(run({ kind: "prod", surface: "page" })), "none");
});
test("no thread and no --no-confirm fails closed; headless runs mirror the schedule column", () => {
  assert.equal(run({ kind: "lab", surface: "cli", threadId: null }).allowed, false);
  assert.equal(confirmOf(run({ kind: "lab", surface: "cli", threadId: null, noConfirm: true })), "none");
  assert.equal(confirmOf(run({ kind: "staging", surface: "cli", threadId: null, noConfirm: true, check: false })), "none");
  assert.equal(confirmOf(run({ kind: "customer", surface: "tool", threadId: null, noConfirm: true, check: false })), "none");
  assert.equal(confirmOf(run({ kind: "prod", surface: "cli", threadId: null, noConfirm: true })), "none");
  assert.deepEqual(run({ kind: "prod", surface: "cli", threadId: null, noConfirm: true, check: false }), { allowed: false, reason: PROD_MSG });
  assert.equal(run({ kind: "prod", surface: "tool", threadId: null }).allowed, false);
});
test("schedules skip forms but stay subject to prod check-only", () => {
  assert.equal(confirmOf(run({ kind: "staging", surface: "schedule", noConfirm: true, check: false })), "none");
  assert.equal(confirmOf(run({ kind: "other", surface: "schedule", check: false })), "none");
  assert.equal(confirmOf(run({ kind: "prod", surface: "schedule" })), "none");
  assert.deepEqual(run({ kind: "prod", surface: "schedule", check: false }), { allowed: false, reason: PROD_MSG });
});
test("prompting specs are refused", () => {
  assert.equal(wouldPrompt(spec(), true, null), "inventory is vault-encrypted and no credential reference names a vault password file");
  assert.equal(wouldPrompt(spec(), true, { id: "c", envId: "e", name: "x", sshUser: null, keyPath: null, becomeMethod: null, vaultPasswordFile: "/srv/example/.vault", ansibleCfg: null }), null);
  assert.equal(wouldPrompt(spec(), false, null), null);
  assert.equal(decide({ env: { kind: "lab", agentApproval: "none" }, spec: spec(), source: cli, noConfirm: false, vaultedInventory: true, credRef: null }).allowed, false);
  assert.equal(run({ kind: "lab", surface: "schedule", vaulted: true }).allowed, false);
  assert.equal(run({ kind: "lab", surface: "panel", vaulted: true }).allowed, false);
});
