// Server-side owner of every run: starts runs through the host entry, consumes the streamed lines,
// persists events, finishes runs with a recap and a thread notice, reconciles after a worker restart,
// and cancels. Host access goes through the injected `host` so tests script it (see fakeHostClient).
//
// Spike B shaped this: the runner is detached on the control host and lines arrive from a tail, so
// they can re-arrive from the start after `attachRun` (dedupe by seq), status/rc exist only once the
// runner ends on its own, and cancel is `kill -INT <remote pid>`. There is no column for the remote
// pid, so it is kept in memory and mirrored into `RunRow.externalUrl` as `pid:<n>` for cancels after
// a server restart.
import type { ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HostContract, HostSignals, RunMode } from "../host-contract.ts";
import type { EnvBadgeDto, HostStats, PlaybookSummary, RunEvent, RunSpec, RunStatus, RunView } from "../shared/types.ts";
import { cleanName } from "../shared/format.ts";
import { EventNormalizer, recapFromStats, statusFromExit } from "./events/normalize.ts";
import { decide, type Decision, type RunSource } from "./policy.ts";
import { buildRunView, FACTS, matchNodeId } from "./runview.ts";
import type { CredRefRow, PlaybooksEnvRow, RunEventRow, RunRow, RunSourceRow, Store } from "./store.ts";

export type HostClient = Pick<ExperimentalHostClient<HostContract, HostSignals>, "call">;
type LinePayload = { ident: string; seq: number; line: string };
type NotePayload = { ident: string; afterSeq: number; text: string };
type ExitPayload = { ident: string; code: number | null; signal: string | null; status?: string | null };

/** What the environment's last probe recorded; absent when it has not been probed yet. */
export interface ProbeSummary { runner: string | null; posix?: boolean | undefined }
export interface ResolvedEnv { env: PlaybooksEnvRow; hostId: string; probe?: ProbeSummary | undefined }

export interface RunServiceDeps {
  store: Store;
  host: HostClient;
  now(): number;
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
  resolveEnv(envId: string): ResolvedEnv;
  /** A credential reference of that environment only; another environment's reference is unknown here. */
  credRef(envId: string, id: string): CredRefRow | null;
  summaryFor(envId: string, path: string): Promise<PlaybookSummary | null>;
  onRunChanged(runId: string): void;
  notifyThread(threadId: string, text: string): Promise<void>;
  /** Directory for the local copy of a run's stream (per thread; null for headless runs). */
  logDir(threadId: string | null): string;
}

export interface PrepareInput {
  envId: string; playbook: string; spec: RunSpec;
  source: { surface: RunSource; threadId: string | null };
  noConfirm: boolean;
  /** Skips the inventory read when the caller already knows. */
  vaultedInventory?: boolean | undefined;
}
export type Prepared =
  | { allowed: false; reason: string }
  | { allowed: true; confirm: Extract<Decision, { allowed: true }>["confirm"]; phrase: string | null; summaryLine: string };

export interface StartInput {
  envId: string; playbook: string; spec: RunSpec; source: RunSourceRow; approval: string;
  /** The phrase the user typed for `confirm: "typed"`; must equal the env slug. */
  typed?: string | undefined;
}

interface LiveRun {
  runId: string; ident: string; envId: string; hostId: string; controlHost: string; repoPath: string; pid: number;
  normalizer: EventNormalizer;
  /** The next line seq we will accept; lower ones are replays, higher ones wait in `buffer`. */
  expectedSeq: number;
  buffer: Map<number, string>;
  hadStats: boolean;
  canceled: boolean;
  started: boolean;
  logStream: WriteStream | null;
  publishTimer: ReturnType<typeof setTimeout> | null;
  /** Parser summary of the playbook (null when unreadable) and the row ordinals buildRunView would be at, for node ids. */
  summary: PlaybookSummary | null;
  playName: string | null;
  taskIndex: number;
  nodeId: string | null;
}

const OPEN: ReadonlySet<RunStatus> = new Set(["queued", "starting", "running"]);
const STALE_MS = 24 * 3_600_000;
const PUBLISH_DEBOUNCE_MS = 250;
const START_TIMEOUT_MS = 25_000;
/** How long a tracked run may sit in `starting` with no status before the reconciler will look at it. */
const START_GRACE_MS = 30_000;
const NOTICE_MSG_MAX = 200;
const ALL_EVENTS = 1_000_000;
const GLYPH: Record<RunStatus, string> = { queued: "·", starting: "◐", running: "◐", success: "✓", failed: "✗", canceled: "–", unknown: "?" };
const LABEL: Record<RunStatus, string> = { queued: "Queued", starting: "Starting", running: "Running", success: "Success", failed: "Failed", canceled: "Canceled", unknown: "Unknown" };

export const runIdent = (runId: string): string => runId.replace(/^run_/, "");
const pidFromRow = (run: RunRow): number | null => {
  const m = /^pid:(\d+)$/.exec(run.externalUrl ?? "");
  return m ? Number(m[1]) : null;
};
const badge = (e: PlaybooksEnvRow): EnvBadgeDto => ({ slug: e.slug, name: e.name, kind: e.kind, color: e.color });
const stem = (path: string): string => basename(path).replace(/\.ya?ml$/, "");
/** Check runs always show diffs (global constraint): the server forces it whatever the caller sent. */
export const normalizeSpec = (spec: RunSpec): RunSpec => (spec.check && !spec.diff ? { ...spec, diff: true } : spec);

/** ansible-playbook flags and environment for a spec plus its credential reference (inventory is passed separately). */
export function buildArgs(spec: RunSpec, credRef: CredRefRow | null): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  if (spec.check) args.push("--check");
  if (spec.diff) args.push("--diff");
  if (spec.limit) args.push("--limit", spec.limit);
  if (spec.tags.length) args.push("--tags", spec.tags.join(","));
  if (spec.skipTags.length) args.push("--skip-tags", spec.skipTags.join(","));
  if (Object.keys(spec.extraVars).length) args.push("-e", JSON.stringify(spec.extraVars));
  if (spec.verbosity > 0) args.push(`-${"v".repeat(spec.verbosity)}`);
  if (credRef?.sshUser) args.push("-u", credRef.sshUser);
  if (credRef?.keyPath) args.push("--private-key", credRef.keyPath);
  if (credRef?.vaultPasswordFile) args.push("--vault-password-file", credRef.vaultPasswordFile);
  if (credRef?.becomeMethod) args.push("--become-method", credRef.becomeMethod);
  const env: Record<string, string> = {};
  if (credRef?.ansibleCfg) env.ANSIBLE_CONFIG = credRef.ansibleCfg;
  return { args, env };
}

/** runner when the control host has ansible-runner (or was never probed), else jsonl with ansible.posix, else plain text. */
export function chooseMode(probe: ProbeSummary | undefined): RunMode {
  if (!probe || probe.runner) return "runner";
  return probe.posix ? "jsonl" : "text";
}

/** Guess the mode of a run from the first line of its local stream copy (used when re-attaching after a restart). */
function sniffMode(firstLine: string | undefined): RunMode | null {
  if (firstLine === undefined) return null;
  const t = firstLine.trim();
  if (!t.startsWith("{")) return "text";
  return t.includes('"_event"') ? "jsonl" : "runner";
}

export function summaryLine(env: PlaybooksEnvRow, playbook: string, spec: RunSpec): string {
  const parts = [`${env.slug} ${playbook} → ${spec.inventory} (${spec.check ? "check" : "apply"})`];
  if (spec.limit) parts.push(`limit ${spec.limit}`);
  if (spec.tags.length) parts.push(`tags ${spec.tags.join(",")}`);
  if (spec.skipTags.length) parts.push(`skip ${spec.skipTags.join(",")}`);
  return parts.join(" · ");
}

/**
 * The completion message for the originating thread (spec §6.5), as Markdown blocks: L0 line, recap bullets, failure bullets,
 * directive, marker. BB renders directives only in assistant messages, so the `::playbook-run` line is there for the agent
 * to repeat in its own reply, not for BB to render from this notice.
 */
export function noticeText(run: RunRow, env: PlaybooksEnvRow, failures: RunEventRow[]): string {
  const recap = run.recap ?? {};
  const hosts = Object.keys(recap);
  const failed = hosts.filter((h) => recap[h]!.failures > 0 || recap[h]!.unreachable > 0).length;
  const changed = hosts.filter((h) => recap[h]!.changed > 0).length;
  const blocks = [`${GLYPH[run.status]} ${LABEL[run.status]}  ${env.slug} ${run.playbook} → ${run.spec.inventory} (${run.spec.check ? "check" : "apply"}) · ${hosts.length} hosts · ${failed} failed · ${changed} changed`];
  if (hosts.length) {
    blocks.push(hosts.map((h) => {
      const s: HostStats = recap[h]!;
      return `- ${h}: ok=${s.ok} changed=${s.changed} unreachable=${s.unreachable} failed=${s.failures} skipped=${s.skipped} rescued=${s.rescued} ignored=${s.ignored}`;
    }).join("\n"));
  }
  const bullets: string[] = [];
  // The exit code alone is noise next to per-host failures; it matters when there are none (or the run did not fail).
  if (run.error && (run.status !== "failed" || failures.length === 0)) bullets.push(`- ${run.error}`);
  const seen = new Set<string>();
  for (const f of failures) {
    if (!f.host || seen.has(f.host)) continue;
    seen.add(f.host);
    const msg = (f.msg ?? "").replace(/\s+/g, " ").trim();
    bullets.push(`- ${f.host} ${f.kind === "host_unreachable" ? "!" : "✗"} ${f.task ?? f.kind}${msg ? `: ${msg.slice(0, NOTICE_MSG_MAX)}` : ""}`);
  }
  if (bullets.length) blocks.push(bullets.join("\n"));
  blocks.push(`::playbook-run{id="${run.id}"}`, `[playbooks:${run.id}]`);
  return blocks.join("\n\n");
}

export class RunService {
  private readonly d: RunServiceDeps;
  private readonly live = new Map<string, LiveRun>(); // by ident

  constructor(deps: RunServiceDeps) {
    this.d = deps;
  }

  ident(runId: string): string {
    return runIdent(runId);
  }

  /** Policy check before a run: refuses prompting or disallowed specs, else says which confirmation is needed. */
  async prepare(input: PrepareInput): Promise<Prepared> {
    const { env, hostId } = this.d.resolveEnv(input.envId);
    if (!env.enabled) return { allowed: false, reason: `environment ${env.slug} is disabled` };
    const spec = normalizeSpec(input.spec);
    const credRef = spec.credRefId ? this.d.credRef(env.id, spec.credRefId) : null;
    const vaultedInventory = input.vaultedInventory ?? (await this.inventoryIsVaulted(env, hostId, spec.inventory));
    const decision = decide({ env, spec, source: input.source, noConfirm: input.noConfirm, vaultedInventory, credRef });
    if (!decision.allowed) return decision;
    const phrase = decision.phrase ?? (decision.confirm === "typed" ? env.slug : null);
    return { allowed: true, confirm: decision.confirm, phrase, summaryLine: summaryLine(env, input.playbook, spec) };
  }

  /** A file inventory starting with the vault header is vaulted; a directory inventory or a read error counts as not vaulted. */
  private async inventoryIsVaulted(env: PlaybooksEnvRow, hostId: string, inventory: string): Promise<boolean> {
    if (!inventory) return false;
    try {
      const r = await this.d.host.call("readFile", { controlHost: env.controlHost, repoPath: env.repoPath, path: inventory }, { hostId });
      return r.content.startsWith("$ANSIBLE_VAULT;");
    } catch (err) {
      this.d.log("debug", "inventory read failed; assuming not vaulted", { inventory, error: String(err) });
      return false;
    }
  }

  /** Insert the run, launch the detached runner on the control host, and start tracking its stream. */
  async start(input: StartInput): Promise<RunRow> {
    const { env, hostId, probe } = this.d.resolveEnv(input.envId);
    if (input.approval === "typed" && input.typed !== env.slug) throw new Error(`typed confirmation does not match the environment slug ${env.slug}`);
    const spec = normalizeSpec(input.spec);
    const credRef = spec.credRefId ? this.d.credRef(env.id, spec.credRefId) : null;
    const summary = await this.d.summaryFor(env.id, input.playbook).catch(() => null);
    const row = this.d.store.insertRun({
      envId: env.id, runnerKind: env.runnerKind, playbook: input.playbook, playbookName: summary?.name ?? stem(input.playbook),
      playbookHash: summary?.hash ?? null, templateId: null, spec, source: input.source, approval: input.approval,
    });
    const ident = this.ident(row.id);
    const { args, env: runEnv } = buildArgs(spec, credRef);
    const mode = chooseMode(probe);
    const logPath = join(this.d.logDir(input.source.threadId), `${row.id}.log`);
    // Known before the host call so a concurrent reconcile sees a starting run with an ident, not a queued orphan.
    this.d.store.updateRun(row.id, { status: "starting", externalId: ident });
    let pid: number;
    try {
      const r = await this.d.host.call("startRun", {
        controlHost: env.controlHost, repoPath: env.repoPath, ident, playbook: input.playbook,
        inventory: spec.inventory || undefined, args, env: runEnv, mode,
      }, { hostId, timeoutMs: START_TIMEOUT_MS });
      pid = r.pid;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = this.d.store.updateRun(row.id, { status: "failed", error: `start failed: ${message}`, endedAt: this.d.now() })!;
      this.d.onRunChanged(row.id);
      if (input.source.threadId) {
        const text = `${GLYPH.failed} ${LABEL.failed}  ${summaryLine(env, input.playbook, spec)} · ${failed.error}\n\n[playbooks:${row.id}]`;
        void this.d.notifyThread(input.source.threadId, text).catch((e) => this.d.log("warn", "run notice failed", { runId: row.id, error: String(e) }));
      }
      throw err;
    }
    const run = this.d.store.updateRun(row.id, { externalUrl: `pid:${pid}`, logPath })!;
    this.track({ run, env, hostId, pid, mode, expectedSeq: 1, summary });
    this.d.onRunChanged(run.id);
    return run;
  }

  private track(o: { run: RunRow; env: PlaybooksEnvRow; hostId: string; pid: number; mode: RunMode; expectedSeq: number; summary: PlaybookSummary | null }): LiveRun {
    const state: LiveRun = {
      runId: o.run.id, ident: this.ident(o.run.id), envId: o.env.id, hostId: o.hostId, controlHost: o.env.controlHost, repoPath: o.env.repoPath, pid: o.pid,
      normalizer: new EventNormalizer(o.mode), expectedSeq: o.expectedSeq, buffer: new Map(), hadStats: false, canceled: false,
      started: o.run.status === "running", logStream: this.openLog(o.run.logPath), publishTimer: null,
      summary: o.summary, playName: null, taskIndex: 0, nodeId: null,
    };
    if (o.expectedSeq > 1) this.seedOrdinals(state);
    this.live.set(state.ident, state);
    return state;
  }

  /** Continue the row numbering from the events already persisted, so a re-attached run assigns the same node ids. */
  private seedOrdinals(s: LiveRun): void {
    for (const ev of this.d.store.listEventsLight(s.runId)) {
      if (ev.kind === "play_start") { s.playName = ev.play ?? ""; s.taskIndex = 0; s.nodeId = null; }
      else if (ev.kind === "task_start") {
        s.playName ??= ev.play ?? "";
        s.nodeId = ev.nodeId;
        if (cleanName(ev.task ?? "").toLowerCase() !== FACTS) s.taskIndex++;
      }
    }
  }

  /**
   * Node ids at persist time, numbering rows exactly as buildRunView does: a play_start opens a play, a task_start
   * opens a task (an implicit play before any play_start), Gathering Facts takes no ordinal, and every host or item
   * event belongs to the current task. Stored ids are what `--node` filters and run refs look up.
   */
  private assignNode(s: LiveRun, e: Omit<RunEvent, "seq">): void {
    if (e.kind === "play_start") { s.playName = e.play ?? ""; s.taskIndex = 0; s.nodeId = null; return; }
    if (e.kind === "task_start") {
      s.playName ??= e.play ?? "";
      const name = cleanName(e.task ?? "");
      s.nodeId = matchNodeId(s.summary, s.playName, name, s.taskIndex);
      if (name.toLowerCase() !== FACTS) s.taskIndex++;
      e.nodeId = s.nodeId;
      return;
    }
    if (e.kind === "playbook_start" || e.kind === "stats") return;
    e.nodeId = s.nodeId;
  }

  /** Forget a tracker without finishing its run: timers off, local stream copy closed. */
  private untrack(s: LiveRun): void {
    if (s.publishTimer) { clearTimeout(s.publishTimer); s.publishTimer = null; }
    s.logStream?.end();
    this.live.delete(s.ident);
  }

  private openLog(logPath: string | null): WriteStream | null {
    if (!logPath) return null;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      const s = createWriteStream(logPath, { flags: "a" });
      s.on("error", (err) => this.d.log("warn", "run log write failed", { logPath, error: String(err) }));
      return s;
    } catch (err) {
      this.d.log("warn", "run log open failed", { logPath, error: String(err) });
      return null;
    }
  }

  /** Lines already in the local stream copy, so a re-attach continues where the tail left off. */
  private consumedLines(run: RunRow): number {
    if (!run.logPath) return this.d.store.lastEventSeq(run.id);
    try {
      const text = readFileSync(run.logPath, "utf8");
      return text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
    } catch {
      return this.d.store.lastEventSeq(run.id);
    }
  }

  private firstLoggedLine(run: RunRow): string | undefined {
    if (!run.logPath) return undefined;
    try { return readFileSync(run.logPath, "utf8").split("\n")[0] || undefined; } catch { return undefined; }
  }

  /** One line of a run's stream: buffer by seq, drain in order, drop replays. */
  onLine(p: LinePayload): void {
    const s = this.live.get(p.ident);
    if (!s) { this.d.log("debug", "line for an untracked run", { ident: p.ident }); return; }
    if (p.seq < s.expectedSeq) return;
    s.buffer.set(p.seq, p.line);
    while (s.buffer.has(s.expectedSeq)) {
      const line = s.buffer.get(s.expectedSeq)!;
      s.buffer.delete(s.expectedSeq);
      s.expectedSeq += 1;
      this.consume(s, line);
    }
    this.schedulePublish(s);
  }

  /** Chatter from the tail process itself; kept as a `log` event, not part of the stream copy. */
  onNote(p: NotePayload): void {
    const s = this.live.get(p.ident);
    if (!s) return;
    this.d.store.appendEvents(s.runId, [{
      kind: "log", play: null, task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false,
      msg: null, res: null, diff: null, stdout: p.text, source: "text", at: this.d.now(),
    }]);
    this.schedulePublish(s);
  }

  private consume(s: LiveRun, line: string): void {
    const at = this.d.now();
    this.persist(s, s.normalizer.push(line, at));
    s.logStream?.write(`${line}\n`);
    const patch: Parameters<Store["updateRun"]>[1] = { lastLine: line };
    if (!s.started) { s.started = true; patch.status = "running"; patch.startedAt = at; }
    this.d.store.updateRun(s.runId, patch);
  }

  private persist(s: LiveRun, events: Omit<RunEvent, "seq">[]): void {
    if (events.length === 0) return;
    for (const e of events) this.assignNode(s, e);
    if (events.some((e) => e.kind === "stats")) s.hadStats = true;
    this.d.store.appendEvents(s.runId, events);
  }

  private schedulePublish(s: LiveRun): void {
    if (s.publishTimer) return;
    s.publishTimer = setTimeout(() => { s.publishTimer = null; this.d.onRunChanged(s.runId); }, PUBLISH_DEBOUNCE_MS);
    s.publishTimer.unref?.();
  }

  /** The host stopped following the run: finish it, re-attach, or ignore depending on `signal`. */
  onExit(p: ExitPayload): void {
    const s = this.live.get(p.ident);
    if (!s) { this.d.log("debug", "exit for an untracked run", { ident: p.ident, signal: p.signal }); return; }
    if (p.signal === "replaced") return;
    if (p.signal === "tail_lost") { void this.reattach(s); return; }
    if (p.signal !== null) {
      if (p.signal !== "lost") this.d.log("warn", "unexpected exit signal; treating as lost", { runId: s.runId, signal: p.signal });
      this.finish(s, "unknown", "runner lost"); return;
    }
    // Best effort for lines stuck behind a gap: nothing more will arrive.
    for (const seq of [...s.buffer.keys()].sort((a, b) => a - b)) { this.consume(s, s.buffer.get(seq)!); s.buffer.delete(seq); }
    const canceled = s.canceled || p.status === "canceled";
    const status = statusFromExit(p.code, s.hadStats, canceled);
    const error = status === "failed" ? (p.status === "timeout" ? `timeout (exit code ${p.code})` : `exit code ${p.code}`) : null;
    this.finish(s, status, error);
  }

  private async reattach(s: LiveRun): Promise<void> {
    try {
      await this.d.host.call("attachRun", { controlHost: s.controlHost, repoPath: s.repoPath, ident: s.ident, fromLine: s.expectedSeq, pid: s.pid }, { hostId: s.hostId });
    } catch (err) {
      // Untracked from here on, so the reconciler (which only attaches untracked runs) picks it up on its next tick.
      this.d.log("warn", "re-attach failed; the reconciler will pick the run up", { runId: s.runId, error: String(err) });
      if (this.live.get(s.ident) === s) this.untrack(s);
    }
  }

  /** Terminal update: final events, recap, endedAt, thread notice; then the in-memory state is dropped. */
  private finish(s: LiveRun, status: RunStatus, error: string | null): void {
    this.persist(s, s.normalizer.finish());
    this.untrack(s);
    this.complete(s.runId, status, error);
  }

  private complete(runId: string, status: RunStatus, error: string | null): void {
    const stats = this.d.store.lastEventOfKind(runId, "stats");
    const recap = stats ? recapFromStats(stats) : null;
    const run = this.d.store.updateRun(runId, { status, error, recap, endedAt: this.d.now() });
    this.d.onRunChanged(runId);
    if (!run || !run.source.threadId) return;
    let env: PlaybooksEnvRow;
    try { env = this.d.resolveEnv(run.envId).env; } catch (err) { this.d.log("warn", "run notice skipped: environment is gone", { runId, error: String(err) }); return; }
    const failures = this.d.store.listEvents(runId, { cursor: 0, limit: ALL_EVENTS, failedOnly: true });
    void this.d.notifyThread(run.source.threadId, noticeText(run, env, failures))
      .catch((err) => this.d.log("warn", "run notice failed", { runId, error: String(err) }));
  }

  /**
   * SIGINT (or SIGTERM when force) to the remote supervisor; the run ends through its exit signal or the reconciler.
   * The supervisor's liveness is checked first: a stored pid may have been reused by an unrelated process.
   */
  async cancel(runId: string, force: boolean): Promise<{ ok: boolean }> {
    const run = this.d.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (!OPEN.has(run.status)) throw new Error(`run ${runId} is not running (${run.status})`);
    const s = this.live.get(this.ident(runId));
    const pid = s?.pid ?? pidFromRow(run);
    if (pid === null) throw new Error(`run ${runId} has no remote pid to signal`);
    const { env, hostId } = this.d.resolveEnv(run.envId);
    const st = await this.d.host.call("runStatus", { controlHost: env.controlHost, repoPath: env.repoPath, ident: run.externalId ?? this.ident(runId), pid }, { hostId });
    if (st.alive === false) throw new Error(`run ${runId} has no live supervisor to signal (pid ${pid} is gone); it will be finished from its artifacts`);
    const r = await this.d.host.call("cancelRun", { controlHost: env.controlHost, pid, force }, { hostId });
    if (s) s.canceled = true;
    return { ok: r.ok };
  }

  /** Read status/rc from the run's artifacts and finish the run from them; re-attach an untracked run that is still going. */
  async reconcile(runId: string): Promise<RunRow | null> {
    const run = this.d.store.getRun(runId);
    if (!run || !OPEN.has(run.status)) return run;
    const ident = run.externalId;
    if (!ident) return this.giveUp(run, "run never started");
    // Inside the start window the startRun call is still the authority (tracking begins once it returns).
    if (run.status === "starting" && this.d.now() - run.requestedAt < START_GRACE_MS) return run;
    const live = this.live.get(ident);
    const { env, hostId, probe } = this.d.resolveEnv(run.envId);
    const pid = live?.pid ?? pidFromRow(run);
    let status: { status: string | null; rc: number | null; alive?: boolean | null };
    try {
      status = await this.d.host.call("runStatus", { controlHost: env.controlHost, repoPath: env.repoPath, ident, ...(pid !== null ? { pid } : {}) }, { hostId });
    } catch (err) {
      this.d.log("warn", "runStatus failed", { runId, error: String(err) });
      return this.stale(run) ? this.giveUp(run, "no status after 24 h") : run;
    }
    // A tracked run with a live supervisor is the tail's to finish: its exit signal follows the last lines and the
    // stats event, and finishing here first would drop them. Reconcile steps in only once the supervisor is dead
    // (or the run has gone stale below).
    if (live && status.status !== null && status.alive !== false) return run;
    if (status.status !== null) {
      const mapped: RunStatus = status.status === "successful" ? "success" : status.status === "canceled" ? "canceled" : "failed";
      const error = mapped === "failed" ? `${status.status === "timeout" ? "timeout" : `exit code ${status.rc ?? "?"}`} (reconciled from artifacts)` : null;
      if (live) this.finish(live, mapped, error); else this.complete(runId, mapped, error);
      return this.d.store.getRun(runId);
    }
    if (status.alive === false) return this.giveUp(run, "runner lost");
    if (this.stale(run)) return this.giveUp(run, "no status after 24 h");
    if (!live && pid !== null) {
      const fromLine = this.consumedLines(run) + 1;
      const mode = sniffMode(this.firstLoggedLine(run)) ?? chooseMode(probe);
      const summary = await this.d.summaryFor(env.id, run.playbook).catch(() => null);
      const s = this.track({ run, env, hostId, pid, mode, expectedSeq: fromLine, summary });
      try {
        await this.d.host.call("attachRun", { controlHost: env.controlHost, repoPath: env.repoPath, ident, fromLine, pid }, { hostId });
      } catch (err) {
        this.d.log("warn", "attachRun failed", { runId, error: String(err) });
        this.untrack(s);
      }
    }
    return this.d.store.getRun(runId);
  }

  private stale(run: RunRow): boolean {
    return this.d.now() - (run.startedAt ?? run.requestedAt) > STALE_MS;
  }

  private giveUp(run: RunRow, error: string): RunRow | null {
    const live = this.live.get(this.ident(run.id));
    if (live) this.finish(live, "unknown", error); else this.complete(run.id, "unknown", error);
    return this.d.store.getRun(run.id);
  }

  /**
   * After a (re)start and on the reconciler's tick: every open run is reconciled. Untracked runs that are still
   * going get re-attached; tracked ones only change when their artifacts say so or they have gone stale.
   */
  async resumeOpenRuns(): Promise<void> {
    for (const run of this.d.store.listOpenRuns()) {
      try {
        await this.reconcile(run.id);
      } catch (err) {
        this.d.log("warn", "resume failed", { runId: run.id, error: String(err) });
      }
    }
  }

  /**
   * The host worker died: its tails and status polls are gone and no exit signal will follow, so every tracker is
   * stale. Drop them all first; reconcile then re-attaches the runs still going and finishes the ones with a status.
   */
  async onWorkerExit(): Promise<void> {
    for (const s of [...this.live.values()]) this.untrack(s);
    await this.resumeOpenRuns();
  }

  async view(runId: string): Promise<RunView | null> {
    const run = this.d.store.getRun(runId);
    if (!run) return null;
    const { env } = this.d.resolveEnv(run.envId);
    const summary = await this.d.summaryFor(run.envId, run.playbook).catch(() => null);
    return buildRunView(run, badge(env), this.d.store.listEventsLight(runId), summary, this.d.store.listInvestigations(runId));
  }
}
