// Host entry: runs on the enrolled BB machine and reaches each environment's Ansible control host
// over ssh. Runs are launched detached on the control host (Spike B: a runner tied to the ssh
// session dies with the worker and never writes status) and streamed back by tailing stream.log.
// The `/host` subpath's runtime bundle carries a CommonJS require shim that fails under plain ESM
// (node --test); the root package exports the same function, so the value import comes from there.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import type { ExperimentalHostRpcContext, ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";
import { createHash } from "node:crypto";
import { LIMITS } from "./shared/constants.ts";
import { hostContract, hostSignals, type HostSignals } from "./host-contract.ts";
import {
  detachedLaunchCommand, discoverInventoriesCommand, findPlaybooksCommand, hashPlaybooksCommand, inventoryListCommand, killCommand, playbookCommand, probeCommand,
  readFileCommand, runDirOf, runnerCommand, runStatusCommand, sshArgs, supervisorCommand, tailLogCommand, tailStreamCommand,
} from "./host/commands.ts";
import { runCapture, startStreaming, type CaptureOptions, type CaptureResult, type StreamHandle } from "./host/process.ts";

export { hostContract, hostSignals };

type Ctx = ExperimentalHostRpcContext<HostSignals>;

export interface HostEntryOptions {
  /** How often a live run's status file is checked. */
  pollMs?: number;
}

interface LiveRun {
  ident: string;
  tail: StreamHandle;
  lease: ExperimentalHostWorkerLease;
  seq: number;
  finished: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  emits: Promise<void>;
}

/** Where a method's command runs: the test override under bash, else the control host. */
const resolve = (controlHost: string, remote: string, override: string | undefined) => (override === undefined ? sshArgs(controlHost, remote) : { cmd: "bash", args: ["-lc", override] });

async function remote(controlHost: string, command: string, override: string | undefined, o: CaptureOptions): Promise<CaptureResult> {
  const { cmd, args } = resolve(controlHost, command, override);
  return runCapture(cmd, args, o);
}

const failure = (r: CaptureResult): string => r.stderr.trim() || r.stdout.trim() || `exit ${r.code ?? "signal"}`;

export interface RunStatus { status: string | null; rc: number | null; lines: number; alive: boolean | null }

/** Split `runStatusCommand` output: status, rc, the stream.log line count, and supervisor liveness (null when unknown). */
export function parseRunStatus(stdout: string): RunStatus {
  const [statusPart = "", rcPart = "", linesPart = "", alivePart = ""] = stdout.split("---");
  const status = statusPart.trim() || null;
  const rcText = rcPart.trim();
  const rc = /^-?\d+$/.test(rcText) ? Number(rcText) : null;
  const lines = /^\d+$/.test(linesPart.trim()) ? Number(linesPart.trim()) : 0;
  const aliveText = alivePart.trim();
  const alive = aliveText === "alive" ? true : aliveText === "dead" ? false : null;
  return { status, rc, lines, alive };
}

export function parseProbe(stdout: string): { ansible: string | null; runner: string | null; head: string | null; python3: string | null } {
  const [a = "", r = "", h = "", py = ""] = stdout.split("---");
  const pick = (s: string) => s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
  return { ansible: pick(a), runner: pick(r), head: pick(h), python3: pick(py) };
}

/** Phase 1 is ssh-only: "local" exists for the test path and is refused unless the call carries an overrideCommand. */
function assertHost(i: { controlHost: string; overrideCommand?: string }): void {
  if (i.controlHost === "local" && i.overrideCommand === undefined) throw new Error('local_not_allowed: controlHost "local" is only valid together with overrideCommand (tests)');
}

export function createHostEntry(options: HostEntryOptions = {}) {
  const pollMs = options.pollMs ?? 2000;
  const live = new Map<string, LiveRun>();

  const emit = (run: LiveRun, fn: () => Promise<void>) => {
    run.emits = run.emits.then(fn).catch(() => undefined);
  };

  const finish = (run: LiveRun, ctx: Ctx, payload: { code: number | null; signal: string | null; status: string | null }) => {
    if (run.finished) return;
    run.finished = true;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    live.delete(run.ident);
    emit(run, () => ctx.experimental_emitSignal("exit", { ident: run.ident, ...payload }));
    emit(run, () => run.lease.dispose());
  };

  /** Tail stream.log from `fromLine` and watch for the status file; shared by startRun and attachRun. */
  function follow(ctx: Ctx, i: { controlHost: string; repoPath: string; ident: string; fromLine: number; pid?: number; overrideCommand?: string }): void {
    const existing = live.get(i.ident);
    if (existing) {
      existing.tail.kill();
      finish(existing, ctx, { code: null, signal: "replaced", status: null });
    }
    const tailCmd = resolve(i.controlHost, tailStreamCommand(i.repoPath, i.ident, i.fromLine), i.overrideCommand);
    const lease = ctx.experimental_retainWorker();
    const run: LiveRun = { ident: i.ident, seq: i.fromLine - 1, finished: false, timer: null, emits: Promise.resolve(), lease, tail: { pid: -1, kill: () => undefined } };
    let stopping = false;
    let pending: { code: number | null; signal: string | null; status: string | null } | null = null;
    let statusSeen = 0;
    let deadSeen = 0;
    run.tail = startStreaming(tailCmd.cmd, tailCmd.args, {
      onLine: (line, source) => {
        if (run.finished) return;
        if (source === "stderr") {
          // The tail process talking, not stream.log content: no seq of its own.
          const afterSeq = run.seq;
          const text = line.replace(/^stderr: /, "");
          emit(run, () => ctx.experimental_emitSignal("note", { ident: i.ident, afterSeq, text }));
          return;
        }
        run.seq += 1;
        const seq = run.seq;
        emit(run, () => ctx.experimental_emitSignal("line", { ident: i.ident, seq, line }));
      },
      onExit: () => {
        if (stopping && pending) finish(run, ctx, pending);
        else finish(run, ctx, { code: null, signal: "tail_lost", status: null });
      },
      onError: () => finish(run, ctx, { code: null, signal: "tail_lost", status: null }),
    });
    live.set(i.ident, run);

    const poll = async () => {
      if (run.finished || stopping) return;
      let st: RunStatus;
      try {
        const r = await remote(i.controlHost, runStatusCommand(i.repoPath, i.ident, i.pid), undefined, { signal: ctx.lifecycle.signal, timeoutMs: Math.max(5000, pollMs * 3), maxBytes: 4096 });
        st = parseRunStatus(r.stdout);
      } catch {
        st = { status: null, rc: null, lines: 0, alive: null };
      }
      if (run.finished) return;
      const stop = (payload: NonNullable<typeof pending>) => {
        stopping = true;
        pending = payload;
        run.tail.kill();
      };
      if (st.status !== null) {
        statusSeen += 1;
        // Give the tail one more interval to deliver the last lines (and the rc file to land) before stopping it.
        const drained = run.seq >= st.lines && (st.rc !== null || statusSeen > 1);
        if (drained || statusSeen > 3) return stop({ code: st.rc, signal: null, status: st.status });
      } else if (st.alive === false) {
        // No status and the supervisor is gone (python3 missing, SIGKILL, reboot): two polls in a row ends the run as lost.
        deadSeen += 1;
        if (deadSeen >= 2) return stop({ code: null, signal: "lost", status: null });
      } else {
        deadSeen = 0;
      }
      run.timer = setTimeout(() => void poll(), st.status !== null || deadSeen > 0 ? Math.min(pollMs, 250) : pollMs);
    };
    run.timer = setTimeout(() => void poll(), Math.min(pollMs, 250));
  }

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      async probe(i, ctx) {
        assertHost(i);
        const r = await remote(i.controlHost, probeCommand(i.repoPath), i.overrideCommand, { signal: ctx.signal, timeoutMs: 20_000, maxBytes: 65_536 });
        if (r.code !== 0) return { ok: false, ansible: null, runner: null, head: null, python3: null, error: failure(r) };
        const p = parseProbe(r.stdout);
        const missing = [p.ansible === null ? "ansible" : null, p.python3 === null ? "python3" : null].filter((m): m is string => m !== null);
        return { ok: missing.length === 0, ...p, error: missing.length ? `${missing.join(" and ")} not found on ${i.controlHost}` : null };
      },
      async readFile(i, ctx) {
        assertHost(i);
        const r = await remote(i.controlHost, readFileCommand(i.repoPath, i.path), i.overrideCommand, { signal: ctx.signal, timeoutMs: 30_000, maxBytes: LIMITS.readFile + 256 });
        if (r.code !== 0) throw new Error(`read_failed: ${i.path}: ${failure(r)}`);
        const nl = r.stdout.indexOf("\n");
        const bytes = Number(r.stdout.slice(0, nl < 0 ? undefined : nl).trim());
        if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`read_failed: ${i.path}: no byte count`);
        if (bytes > LIMITS.readFile) throw new Error(`too_large: ${i.path} is ${bytes} bytes (limit ${LIMITS.readFile})`);
        const content = nl < 0 ? "" : r.stdout.slice(nl + 1);
        return { content, bytes, hash: createHash("sha256").update(content).digest("hex") };
      },
      async listPlaybooks(i, ctx) {
        assertHost(i);
        const r = await remote(i.controlHost, findPlaybooksCommand(i.repoPath), i.overrideCommand, { signal: ctx.signal, timeoutMs: 30_000, maxBytes: 1_048_576 });
        if (r.code !== 0) throw new Error(`list_failed: ${failure(r)}`);
        return { paths: r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0) };
      },
      async hashPlaybooks(i, ctx) {
        assertHost(i);
        const r = await remote(i.controlHost, hashPlaybooksCommand(i.repoPath), i.overrideCommand, { signal: ctx.signal, timeoutMs: 60_000, maxBytes: 1_048_576 });
        if (r.code !== 0) throw new Error(`list_failed: ${failure(r)}`);
        const files: { path: string; hash: string; bytes: number }[] = [];
        for (const l of r.stdout.split("\n")) {
          const [path, hash, bytes] = l.split("\t");
          if (path && hash && /^[0-9a-f]{64}$/.test(hash) && bytes !== undefined && /^\d+$/.test(bytes)) files.push({ path, hash, bytes: Number(bytes) });
        }
        return { files };
      },
      async discoverInventories(i, ctx) {
        assertHost(i);
        const r = await remote(i.controlHost, discoverInventoriesCommand(i.inventoryRoot), i.overrideCommand, { signal: ctx.signal, timeoutMs: 30_000, maxBytes: 262_144 });
        const entries: { path: string; kind: "file" | "directory" }[] = [];
        for (const l of r.stdout.split("\n")) {
          const m = /^([fd]) (.+)$/.exec(l);
          if (m) entries.push({ path: m[2]!, kind: m[1] === "d" ? "directory" : "file" });
        }
        return { entries };
      },
      async resolveInventory(i, ctx) {
        assertHost(i);
        const r = await remote(i.controlHost, inventoryListCommand(i.repoPath, i.inventory), i.overrideCommand, { signal: ctx.signal, timeoutMs: 60_000, maxBytes: 8 * 1_048_576 });
        if (r.code !== 0) throw new Error(`inventory_failed: ${failure(r)}`);
        return { json: r.stdout };
      },
      async syntaxCheck(i, ctx) {
        assertHost(i);
        const cmd = playbookCommand({ repoPath: i.repoPath, playbook: i.playbook, inventory: i.inventory, cmdline: ["--syntax-check"], envVars: {}, mode: "text" });
        const r = await remote(i.controlHost, cmd, i.overrideCommand, { signal: ctx.signal, timeoutMs: 120_000, maxBytes: 1_048_576 });
        return { ok: r.code === 0, output: r.stdout + r.stderr };
      },
      async listTasks(i, ctx) {
        assertHost(i);
        const cmd = playbookCommand({ repoPath: i.repoPath, playbook: i.playbook, inventory: i.inventory, cmdline: ["--list-tasks"], envVars: {}, mode: "text" });
        const r = await remote(i.controlHost, cmd, i.overrideCommand, { signal: ctx.signal, timeoutMs: 120_000, maxBytes: 1_048_576 });
        return { ok: r.code === 0, output: r.stdout + r.stderr };
      },
      async startRun(i, ctx) {
        assertHost(i);
        const runDir = runDirOf(i.repoPath, i.ident);
        const inner =
          i.mode === "runner"
            ? runnerCommand({ repoPath: i.repoPath, ident: i.ident, playbook: i.playbook, inventory: i.inventory, cmdline: i.args, envVars: i.env })
            : playbookCommand({ repoPath: i.repoPath, playbook: i.playbook, inventory: i.inventory, cmdline: i.args, envVars: i.env, mode: i.mode });
        const launch = detachedLaunchCommand(runDir, supervisorCommand({ runDir, ident: i.ident, inner }), i.repoPath);
        const r = await remote(i.controlHost, launch, i.overrideCommand, { signal: ctx.signal, timeoutMs: 30_000, maxBytes: 65_536 });
        const pidText = r.stdout.trim().split("\n").pop()?.trim() ?? "";
        if (r.code !== 0 || !/^\d+$/.test(pidText) || Number(pidText) <= 0) throw new Error(`launch_failed: ${r.code !== 0 ? failure(r) : `no pid in ${JSON.stringify(r.stdout.slice(0, 200))}`}`);
        // The tail and the status poll always run against the control host (or bash for "local"); only the launch takes the override.
        follow(ctx, { controlHost: i.controlHost, repoPath: i.repoPath, ident: i.ident, fromLine: 1, pid: Number(pidText) });
        return { pid: Number(pidText) };
      },
      async attachRun(i, ctx) {
        assertHost(i);
        follow(ctx, { controlHost: i.controlHost, repoPath: i.repoPath, ident: i.ident, fromLine: i.fromLine, pid: i.pid, overrideCommand: i.overrideCommand });
        return { attached: true };
      },
      async cancelRun(i, ctx) {
        assertHost(i);
        const r = await remote(i.controlHost, killCommand(i.pid, i.force ? "TERM" : "INT"), i.overrideCommand, { signal: ctx.signal, timeoutMs: 20_000, maxBytes: 4096 });
        return { ok: r.code === 0 };
      },
      async runStatus(i, ctx) {
        assertHost(i);
        const r = await remote(i.controlHost, runStatusCommand(i.repoPath, i.ident, i.pid), i.overrideCommand, { signal: ctx.signal, timeoutMs: 20_000, maxBytes: 4096 });
        return parseRunStatus(r.stdout);
      },
      async tailLog(i, ctx) {
        assertHost(i);
        const r = await remote(i.controlHost, tailLogCommand(i.repoPath, i.ident, i.bytes), i.overrideCommand, { signal: ctx.signal, timeoutMs: 20_000, maxBytes: i.bytes + 4096 });
        return { text: r.stdout };
      },
    },
    async dispose() {
      // Local tails only: the runners keep going on the control host and are reconciled from their status files.
      const runs = [...live.values()];
      live.clear();
      for (const run of runs) {
        run.finished = true;
        if (run.timer) clearTimeout(run.timer);
        run.tail.kill();
      }
      // Let queued line/note emits land before the leases go.
      await Promise.all(runs.map((run) => run.emits));
      await Promise.all(runs.map((run) => run.lease.dispose()));
    },
  });
}

export default createHostEntry();
