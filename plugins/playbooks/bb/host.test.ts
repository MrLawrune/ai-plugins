import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry, { createHostEntry } from "./host.ts";
import { detachedLaunchCommand, discoverInventoriesCommand, findPlaybooksCommand, hashPlaybooksCommand, killCommand, readFileCommand, runStatusCommand, supervisorCommand, tailLogCommand, tailStreamCommand } from "./host/commands.ts";

// Every test drives the host entry against local processes: `controlHost: "local"` is accepted only
// together with `overrideCommand`, which then runs under bash; derived tails and status polls of an
// overridden call run their real commands under bash too.
const local = (...a: [string, string, number] | [string, string]) => ({ overrideCommand: a.length === 3 ? tailStreamCommand(a[0], a[1], a[2]) : runStatusCommand(a[0], a[1]) });
const repo = () => mkdtempSync(join(tmpdir(), "pb-host-"));
const launch = (repoPath: string, ident: string, inner: string) =>
  detachedLaunchCommand(`${repoPath}/.bb-runs/${ident}`, supervisorCommand({ runDir: `${repoPath}/.bb-runs/${ident}`, ident, inner }), repoPath);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(25);
  }
}
type Sig = { signal: string; payload: unknown };
const linesOf = (sigs: readonly Sig[], ident: string) =>
  sigs.filter((s) => s.signal === "line" && (s.payload as { ident: string }).ident === ident).map((s) => {
    const { seq, line } = s.payload as { seq: number; line: string };
    return { seq, line };
  });
const exitOf = (sigs: readonly Sig[], ident: string) => {
  const p = sigs.find((s) => s.signal === "exit" && (s.payload as { ident: string }).ident === ident)?.payload as { code: number | null; signal: string | null; status: string | null } | undefined;
  return p === undefined ? undefined : { code: p.code, signal: p.signal, status: p.status };
};

test("default export is a host entry with the contract and signals", () => {
  assert.equal(hostEntry.experimental_apiVersion, 1);
  for (const m of ["probe", "readFile", "listPlaybooks", "hashPlaybooks", "discoverInventories", "resolveInventory", "syntaxCheck", "listTasks", "startRun", "attachRun", "cancelRun", "runStatus", "tailLog"]) assert.ok(m in hostEntry.contract, m);
  assert.deepEqual(Object.keys(hostEntry.experimental_signals ?? {}).sort(), ["exit", "line", "note"]);
});

test("startRun launches detached, streams numbered lines, and emits exit with the rc", async () => {
  const dir = repo();
  const h = experimental_createHostEntryHarness(createHostEntry({ pollMs: 100 }));
  try {
    const r = await h.experimental_call("startRun", {
      controlHost: "local", repoPath: dir, ident: "t1", playbook: "x.yml", args: [], env: {}, mode: "text",
      overrideCommand: launch(dir, "t1", "printf 'a\\n'; sleep 0.3; printf 'b\\n{\"c\":1}\\n'; exit 3"),
    });
    assert.ok(r.pid > 0);
    assert.equal(h.experimental_getRetainedWorkerLeaseCount(), 1);
    await until(() => exitOf(h.experimental_getSignals(), "t1") !== undefined);
    assert.deepEqual(linesOf(h.experimental_getSignals(), "t1"), [{ seq: 1, line: "a" }, { seq: 2, line: "b" }, { seq: 3, line: '{"c":1}' }]);
    assert.deepEqual(exitOf(h.experimental_getSignals(), "t1"), { code: 3, signal: null, status: "failed" });
    assert.equal(readFileSync(`${dir}/.bb-runs/t1/artifacts/t1/status`, "utf8"), "failed");
    assert.equal(readFileSync(`${dir}/.bb-runs/t1/artifacts/t1/rc`, "utf8"), "3");
    await until(() => h.experimental_getRetainedWorkerLeaseCount() === 0, 2000);
    const st = await h.experimental_call("runStatus", { controlHost: "local", repoPath: dir, ident: "t1", pid: r.pid, overrideCommand: runStatusCommand(dir, "t1", r.pid) });
    assert.deepEqual(st, { status: "failed", rc: 3, lines: 3, alive: false });
    const tl = await h.experimental_call("tailLog", { controlHost: "local", repoPath: dir, ident: "t1", bytes: 4, overrideCommand: tailLogCommand(dir, "t1", 4) });
    assert.equal(tl.text, ":1}\n");
  } finally {
    await h.experimental_dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the supervisor leaves the runner's own status and rc alone", async () => {
  const dir = repo();
  const h = experimental_createHostEntryHarness(createHostEntry({ pollMs: 100 }));
  try {
    const art = `${dir}/.bb-runs/t2/artifacts/t2`;
    await h.experimental_call("startRun", {
      controlHost: "local", repoPath: dir, ident: "t2", playbook: "x.yml", args: [], env: {}, mode: "runner",
      overrideCommand: launch(dir, "t2", `mkdir -p '${art}' && printf 2 > '${art}/rc' && printf canceled > '${art}/status'; exit 0`),
    });
    await until(() => exitOf(h.experimental_getSignals(), "t2") !== undefined);
    assert.deepEqual(exitOf(h.experimental_getSignals(), "t2"), { code: 2, signal: null, status: "canceled" });
  } finally {
    await h.experimental_dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelRun interrupts the supervised command and the run ends as canceled", async () => {
  const dir = repo();
  const h = experimental_createHostEntryHarness(createHostEntry({ pollMs: 100 }));
  try {
    const r = await h.experimental_call("startRun", {
      controlHost: "local", repoPath: dir, ident: "t3", playbook: "x.yml", args: [], env: {}, mode: "jsonl",
      // Real inner commands `exec` into ansible (see runnerCommand), so the forwarded SIGINT reaches the program itself.
      overrideCommand: launch(dir, "t3", "echo started; exec sleep 30"),
    });
    await until(() => linesOf(h.experimental_getSignals(), "t3").length === 1);
    const c = await h.experimental_call("cancelRun", { controlHost: "local", pid: r.pid, force: false, overrideCommand: killCommand(r.pid, "INT") });
    assert.deepEqual(c, { ok: true });
    await until(() => exitOf(h.experimental_getSignals(), "t3") !== undefined);
    assert.deepEqual(exitOf(h.experimental_getSignals(), "t3"), { code: 130, signal: null, status: "canceled" });
    assert.deepEqual(linesOf(h.experimental_getSignals(), "t3").map((l) => l.line), ["started"]);
    const again = await h.experimental_call("cancelRun", { controlHost: "local", pid: r.pid, force: true, overrideCommand: killCommand(r.pid, "TERM") });
    assert.deepEqual(again, { ok: false });
  } finally {
    await h.experimental_dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attachRun re-opens the tail from a line offset and numbers from there", async () => {
  const dir = repo();
  const h = experimental_createHostEntryHarness(createHostEntry({ pollMs: 100 }));
  try {
    const run = `${dir}/.bb-runs/t4`;
    mkdirSync(`${run}/artifacts/t4`, { recursive: true });
    writeFileSync(`${run}/stream.log`, "one\ntwo\nthree\n");
    await h.experimental_call("attachRun", { controlHost: "local", repoPath: dir, ident: "t4", fromLine: 3, ...local(dir, "t4", 3) });
    assert.equal(h.experimental_getRetainedWorkerLeaseCount(), 1);
    await until(() => linesOf(h.experimental_getSignals(), "t4").length === 1);
    writeFileSync(`${run}/stream.log`, "one\ntwo\nthree\nfour\n");
    await until(() => linesOf(h.experimental_getSignals(), "t4").length === 2);
    writeFileSync(`${run}/artifacts/t4/rc`, "0");
    writeFileSync(`${run}/artifacts/t4/status`, "successful");
    await until(() => exitOf(h.experimental_getSignals(), "t4") !== undefined);
    assert.deepEqual(linesOf(h.experimental_getSignals(), "t4"), [{ seq: 3, line: "three" }, { seq: 4, line: "four" }]);
    assert.deepEqual(exitOf(h.experimental_getSignals(), "t4"), { code: 0, signal: null, status: "successful" });
  } finally {
    await h.experimental_dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tail that dies before status is reported as tail_lost", async () => {
  const dir = repo();
  const h = experimental_createHostEntryHarness(createHostEntry({ pollMs: 100 }));
  try {
    mkdirSync(`${dir}/.bb-runs/t5`, { recursive: true });
    writeFileSync(`${dir}/.bb-runs/t5/stream.log`, "x\n");
    await h.experimental_call("attachRun", { controlHost: "local", repoPath: dir, ident: "t5", fromLine: 1, overrideCommand: "echo x; exit 0" });
    await until(() => exitOf(h.experimental_getSignals(), "t5") !== undefined);
    assert.deepEqual(exitOf(h.experimental_getSignals(), "t5"), { code: null, signal: "tail_lost", status: null });
    assert.equal(h.experimental_getRetainedWorkerLeaseCount(), 0);
  } finally {
    await h.experimental_dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispose kills local tails and releases leases", async () => {
  const dir = repo();
  const h = experimental_createHostEntryHarness(createHostEntry({ pollMs: 100 }));
  mkdirSync(`${dir}/.bb-runs/t6`, { recursive: true });
  writeFileSync(`${dir}/.bb-runs/t6/stream.log`, "");
  await h.experimental_call("attachRun", { controlHost: "local", repoPath: dir, ident: "t6", fromLine: 1, ...local(dir, "t6", 1) });
  assert.equal(h.experimental_getRetainedWorkerLeaseCount(), 1);
  await h.experimental_dispose();
  assert.equal(h.experimental_getRetainedWorkerLeaseCount(), 0);
  assert.equal(exitOf(h.experimental_getSignals(), "t6"), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("a run whose supervisor dies without writing status ends as lost", async () => {
  const dir = repo();
  const h = experimental_createHostEntryHarness(createHostEntry({ pollMs: 100 }));
  try {
    const run = `${dir}/.bb-runs/t8`;
    const r = await h.experimental_call("startRun", {
      controlHost: "local", repoPath: dir, ident: "t8", playbook: "x.yml", args: [], env: {}, mode: "text",
      overrideCommand: `mkdir -p '${run}' && { setsid nohup bash -c 'echo only; exec sleep 0.4' > '${run}/stream.log' 2>&1 < /dev/null & echo $!; }`,
    });
    assert.ok(r.pid > 0);
    await until(() => exitOf(h.experimental_getSignals(), "t8") !== undefined);
    assert.deepEqual(exitOf(h.experimental_getSignals(), "t8"), { code: null, signal: "lost", status: null });
    assert.deepEqual(linesOf(h.experimental_getSignals(), "t8"), [{ seq: 1, line: "only" }]);
    await until(() => h.experimental_getRetainedWorkerLeaseCount() === 0, 2000);
  } finally {
    await h.experimental_dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stderr from the tail becomes a note and never consumes a seq", async () => {
  const dir = repo();
  const h = experimental_createHostEntryHarness(createHostEntry({ pollMs: 100 }));
  try {
    mkdirSync(`${dir}/.bb-runs/t9`, { recursive: true });
    writeFileSync(`${dir}/.bb-runs/t9/stream.log`, "");
    await h.experimental_call("attachRun", { controlHost: "local", repoPath: dir, ident: "t9", fromLine: 1, overrideCommand: "echo a; sleep 0.05; echo warn >&2; sleep 0.05; echo b; sleep 0.1" });
    await until(() => exitOf(h.experimental_getSignals(), "t9") !== undefined);
    assert.deepEqual(linesOf(h.experimental_getSignals(), "t9"), [{ seq: 1, line: "a" }, { seq: 2, line: "b" }]);
    const notes = h.experimental_getSignals().filter((s) => s.signal === "note").map((s) => s.payload as { ident: string; afterSeq: number; text: string });
    assert.deepEqual(notes, [{ ident: "t9", afterSeq: 1, text: "warn" }]);
  } finally {
    await h.experimental_dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local is only accepted together with overrideCommand", async () => {
  const h = experimental_createHostEntryHarness(hostEntry);
  await assert.rejects(h.experimental_call("runStatus", { controlHost: "local", repoPath: "/tmp", ident: "x" }), /local_not_allowed/);
  await assert.rejects(h.experimental_call("attachRun", { controlHost: "local", repoPath: "/tmp", ident: "x", fromLine: 1 }), /local_not_allowed/);
  await assert.rejects(h.experimental_call("cancelRun", { controlHost: "local", pid: 1, force: false }), /local_not_allowed/);
  await assert.rejects(h.experimental_call("startRun", { controlHost: "local", repoPath: "/tmp", ident: "x", playbook: "x.yml", args: [], env: {}, mode: "text" }), /local_not_allowed/);
  assert.equal(h.experimental_getRetainedWorkerLeaseCount(), 0);
  await h.experimental_dispose();
});

test("the contract rejects hostile env keys before any command is built", async () => {
  const h = experimental_createHostEntryHarness(hostEntry);
  await assert.rejects(
    h.experimental_call("startRun", { controlHost: "local", repoPath: "/tmp", ident: "x", playbook: "x.yml", args: [], env: { "X; touch /tmp/pwned; Y": "1" }, mode: "text", overrideCommand: "echo 1" }),
  );
  await h.experimental_dispose();
});

test("startRun rejects a launch that does not print a pid", async () => {
  const h = experimental_createHostEntryHarness(hostEntry);
  await assert.rejects(
    h.experimental_call("startRun", { controlHost: "local", repoPath: "/tmp", ident: "t7", playbook: "x.yml", args: [], env: {}, mode: "text", overrideCommand: "echo nope" }),
    /launch_failed/,
  );
  await assert.rejects(
    h.experimental_call("startRun", { controlHost: "local", repoPath: "/tmp", ident: "bad ident", playbook: "x.yml", args: [], env: {}, mode: "text", overrideCommand: "echo 1" }),
  );
  await h.experimental_dispose();
});

test("readFile returns content with its sha256 and refuses files over the limit", async () => {
  const h = experimental_createHostEntryHarness(hostEntry);
  const dir = repo();
  try {
    writeFileSync(`${dir}/site.yml`, "- hosts: all\n");
    const r = await h.experimental_call("readFile", { controlHost: "local", repoPath: dir, path: "site.yml", overrideCommand: readFileCommand(dir, "site.yml") });
    assert.deepEqual(r, { content: "- hosts: all\n", bytes: 13, hash: createHash("sha256").update("- hosts: all\n").digest("hex") });
    await assert.rejects(h.experimental_call("readFile", { controlHost: "local", repoPath: "/", path: "dev/zero", overrideCommand: "echo 2000000; head -c 10 /dev/zero" }), /too_large/);
    await assert.rejects(h.experimental_call("readFile", { controlHost: "local", repoPath: dir, path: "missing.yml", overrideCommand: readFileCommand(dir, "missing.yml") }), /read_failed/);
    await assert.rejects(h.experimental_call("readFile", { controlHost: "local", repoPath: dir, path: "../etc/passwd", overrideCommand: "echo 1" }), /relative path/);
  } finally {
    await h.experimental_dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe parses the three sections and reports a missing ansible", async () => {
  const h = experimental_createHostEntryHarness(hostEntry);
  const ok = await h.experimental_call("probe", { controlHost: "local", repoPath: "/srv/example", overrideCommand: "printf 'ansible [core 2.17.3]\\n---\\n2.4.0\\n---\\nabc1234\\n---\\n/usr/bin/python3\\n'" });
  assert.deepEqual(ok, { ok: true, ansible: "ansible [core 2.17.3]", runner: "2.4.0", head: "abc1234", python3: "/usr/bin/python3", error: null });
  const noRunner = await h.experimental_call("probe", { controlHost: "local", repoPath: "/srv/example", overrideCommand: "printf 'ansible [core 2.17.3]\\n---\\n---\\n---\\n/usr/bin/python3\\n'" });
  assert.deepEqual(noRunner, { ok: true, ansible: "ansible [core 2.17.3]", runner: null, head: null, python3: "/usr/bin/python3", error: null });
  const none = await h.experimental_call("probe", { controlHost: "local", repoPath: "/srv/example", overrideCommand: "printf -- '---\\n---\\n---\\n/usr/bin/python3\\n'" });
  assert.equal(none.ok, false);
  assert.match(none.error ?? "", /ansible not found/);
  const noPy = await h.experimental_call("probe", { controlHost: "local", repoPath: "/srv/example", overrideCommand: "printf 'ansible [core 2.17.3]\\n---\\n---\\n---\\n'" });
  assert.equal(noPy.ok, false);
  assert.match(noPy.error ?? "", /python3 not found/);
  const down = await h.experimental_call("probe", { controlHost: "local", repoPath: "/srv/example", overrideCommand: "echo 'Connection refused' >&2; exit 255" });
  assert.deepEqual(down, { ok: false, ansible: null, runner: null, head: null, python3: null, error: "Connection refused" });
  await h.experimental_dispose();
});

test("listPlaybooks and discoverInventories map command output", async () => {
  const h = experimental_createHostEntryHarness(hostEntry);
  const dir = repo();
  try {
    mkdirSync(`${dir}/roles/common/tasks`, { recursive: true });
    mkdirSync(`${dir}/.bb-runs/r1`, { recursive: true });
    mkdirSync(`${dir}/inventories/group_vars`, { recursive: true });
    for (const f of ["site.yml", "web/deploy.yaml", "roles/common/tasks/main.yml", ".bb-runs/r1/x.yml", "inventories/staging.yml", "inventories/group_vars/all.yml"]) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), "");
    }
    writeFileSync(`${dir}/inventories/hosts`, "");
    mkdirSync(`${dir}/inventories/prod`, { recursive: true });
    const pb = await h.experimental_call("listPlaybooks", { controlHost: "local", repoPath: dir, overrideCommand: findPlaybooksCommand(dir) });
    assert.deepEqual(pb, { paths: ["inventories/staging.yml", "site.yml", "web/deploy.yaml"] });
    writeFileSync(`${dir}/site.yml`, "- hosts: all\n"); writeFileSync(`${dir}/web/deploy.yaml`, "- hosts: web # ünïcode\n");
    mkdirSync(`${dir}/a b`); writeFileSync(`${dir}/a b/x.yml`, "");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const hashed = await h.experimental_call("hashPlaybooks", { controlHost: "local", repoPath: dir, overrideCommand: hashPlaybooksCommand(dir) });
    assert.deepEqual(hashed, { files: [
      { path: "a b/x.yml", hash: sha(""), bytes: 0 },
      { path: "inventories/staging.yml", hash: sha(""), bytes: 0 },
      { path: "site.yml", hash: sha("- hosts: all\n"), bytes: 13 },
      { path: "web/deploy.yaml", hash: sha("- hosts: web # ünïcode\n"), bytes: Buffer.byteLength("- hosts: web # ünïcode\n") },
    ] });
    const same = await h.experimental_call("readFile", { controlHost: "local", repoPath: dir, path: "web/deploy.yaml", overrideCommand: readFileCommand(dir, "web/deploy.yaml") });
    assert.equal(same.hash, hashed.files[3]!.hash, "hashPlaybooks and readFile agree on the hash");
    const inv = await h.experimental_call("discoverInventories", { controlHost: "local", inventoryRoot: `${dir}/inventories`, overrideCommand: discoverInventoriesCommand(`${dir}/inventories`) });
    assert.deepEqual(inv, { entries: [{ path: "hosts", kind: "file" }, { path: "prod", kind: "directory" }, { path: "staging.yml", kind: "file" }] });
    const missing = await h.experimental_call("discoverInventories", { controlHost: "local", inventoryRoot: `${dir}/nope`, overrideCommand: discoverInventoriesCommand(`${dir}/nope`) });
    assert.deepEqual(missing, { entries: [] });
  } finally {
    await h.experimental_dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syntaxCheck, listTasks, and resolveInventory relay the command result", async () => {
  const h = experimental_createHostEntryHarness(hostEntry);
  const base = { controlHost: "local", repoPath: "/srv/example", playbook: "site.yml", inventory: "hosts" };
  assert.deepEqual(await h.experimental_call("syntaxCheck", { ...base, overrideCommand: "echo 'playbook: site.yml'" }), { ok: true, output: "playbook: site.yml\n" });
  assert.deepEqual(await h.experimental_call("syntaxCheck", { ...base, overrideCommand: "echo 'ERROR! bad' >&2; exit 4" }), { ok: false, output: "ERROR! bad\n" });
  assert.deepEqual(await h.experimental_call("listTasks", { ...base, overrideCommand: "echo 'play #1'" }), { ok: true, output: "play #1\n" });
  assert.deepEqual(await h.experimental_call("resolveInventory", { controlHost: "local", repoPath: "/srv/example", inventory: "hosts", overrideCommand: "echo '{\"_meta\":{}}'" }), { json: '{"_meta":{}}\n' });
  await assert.rejects(h.experimental_call("resolveInventory", { controlHost: "local", repoPath: "/srv/example", inventory: "hosts", overrideCommand: "echo nope >&2; exit 1" }), /inventory_failed/);
  await h.experimental_dispose();
});
