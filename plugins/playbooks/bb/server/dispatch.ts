// Targeted agent dispatch (spec §4.5, §6.7): renders the context block for a target or run ref, spawns "new thread"
// and investigation threads through the SDK, and keeps the investigations table in step with the threads' lifecycle.
import { BUDGETS, LIMITS } from "../shared/constants.ts";
import type { RunView } from "../shared/types.ts";
import { renderContext, type ContextFailure, type ContextInput } from "./context.ts";
import type { EnvService } from "./envs.ts";
import type { LibraryService } from "./library.ts";
import type { RunService } from "./runs.ts";
import { eventsForRow } from "./runview.ts";
import type { PlaybooksEnvRow, RunEventRow, RunRow, Store } from "./store.ts";
import { parseRunRef, parseTarget } from "./targets.ts";

export type SpawnEnvironment = { type: "reuse"; environmentId: string } | { type: "project-default" };
/** The subset of the SDK's thread spawn request the plugin fills in; `readonly` is requested for investigations. */
export interface DispatchSpawnArgs {
  projectId: string;
  prompt: string;
  title: string;
  environment: SpawnEnvironment;
  parentThreadId?: string;
  permissionMode?: "readonly" | "accept-edits";
  providerId?: string;
  model?: string;
  pluginMetadata: { playbooks: Record<string, string | null> };
}
export interface SourceThread { id: string; projectId: string; environmentId: string | null; providerId?: string | undefined; model?: string | undefined; canSpawnChild?: boolean | undefined }
export interface DispatchSdk {
  threads: {
    spawn(args: DispatchSpawnArgs): Promise<{ id: string }>;
    get(args: { threadId: string }): Promise<SourceThread>;
  };
}
export interface DispatchDeps {
  store: Pick<Store, "getRun" | "getEnv" | "listEvents" | "insertInvestigation" | "updateInvestigation" | "investigationByThread">;
  envs: Pick<EnvService, "get" | "health">;
  library: Pick<LibraryService, "summary">;
  runs: Pick<RunService, "view">;
  sdk: DispatchSdk;
  now(): number;
  log(level: "info" | "warn", message: string, data?: Record<string, unknown>): void;
  onRunChanged(runId: string): void;
}

export interface PromptInput { target: string; runId?: string | undefined; instruction: string }
export interface SpawnInput extends PromptInput { projectId: string; threadId?: string | undefined }
export interface InvestigateInput { runId: string; host?: string | undefined; node?: string | undefined; threadId?: string | undefined; projectId?: string | undefined }

const FAILED_KINDS = new Set(["host_failed", "host_unreachable", "item_failed"]);
const ALL_EVENTS = 10_000;
const TITLE_MAX = 60;
const HOSTS_IN_TITLE = 3;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The BB server answers an unknown enum value with a bare `invalid_request`; the SDK error carries the code. */
const isReadonlyRejection = (e: unknown): boolean => {
  const { code } = (e ?? {}) as { code?: unknown };
  return code === "invalid_request" || /permission.?mode/i.test(message(e));
};
const isParentRejected = (e: unknown): boolean => /parent thread/i.test(message(e));
const oneLine = (s: string | null, max: number): string | null => {
  const line = (s ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
  return line === null ? null : line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Failed or unreachable cells in scope with their result event, picked by row ordinal (same-named tasks stay apart). */
export function failedCells(view: RunView, events: RunEventRow[], scope: { host?: string | undefined; node?: string | undefined }): ContextFailure[] {
  const out: ContextFailure[] = [];
  for (const [playIndex, p] of view.plays.entries()) {
    for (const [taskIndex, t] of p.tasks.entries()) {
      if (scope.node && t.nodeId !== scope.node) continue;
      const row = eventsForRow(events, playIndex, taskIndex);
      for (const [host, state] of Object.entries(t.cells)) {
        if (scope.host && host !== scope.host) continue;
        if (state !== "failed" && state !== "unreachable") continue;
        const ev = row.filter((e) => e.host === host && FAILED_KINDS.has(e.kind)).pop();
        out.push({ host, nodeId: t.nodeId ?? t.name, msg: ev?.msg ?? state, res: ev?.res ?? "", stdout: ev?.stdout ?? "", diff: ev?.diff ?? null });
      }
    }
  }
  return out;
}

/** Short name for thread titles: the playbook file name, the env, or the run id. */
export function shortRef(ref: string): string {
  if (ref.startsWith("run_")) return parseRunRef(ref)?.runId ?? ref;
  const t = parseTarget(ref);
  if (!t) return ref;
  return t.path ? t.path.split("/").pop() ?? t.path : t.env;
}

export type EffectiveMode = "readonly" | "accept-edits";

export class DispatchService {
  private readonly d: DispatchDeps;
  /** Set once the host refuses `readonly`; later investigations spawn straight with accept-edits. */
  private readonlyRejected = false;

  constructor(d: DispatchDeps) {
    this.d = d;
  }

  /** The context block for a target or run ref at the given budget. Throws on unknown refs and unreachable hosts. */
  async context(i: { ref: string; runId?: string | undefined; instruction?: string | undefined; budget: number }): Promise<string> {
    return renderContext(await this.input(i.ref, i.runId, i.instruction, i.budget));
  }

  async prompt(i: PromptInput): Promise<{ prompt: string }> {
    return { prompt: await this.context({ ref: i.target, runId: i.runId, instruction: i.instruction, budget: BUDGETS.newThread }) };
  }

  async spawn(i: SpawnInput): Promise<{ threadId: string }> {
    const { prompt } = await this.prompt(i);
    const src = i.threadId ? await this.source(i.threadId) : null;
    const instruction = oneLine(i.instruction, TITLE_MAX);
    const args: DispatchSpawnArgs = {
      projectId: i.projectId, prompt, environment: environmentOf(src),
      title: instruction ? `${shortRef(i.target)}: ${instruction}` : `Playbooks: ${i.target}`,
      ...(src && src.canSpawnChild !== false ? { parentThreadId: src.id } : {}),
      pluginMetadata: { playbooks: { target: i.target, runId: i.runId ?? null, kind: "dispatch" } },
    };
    const thread = await this.spawnThread(args);
    return { threadId: thread.id };
  }

  async investigate(i: InvestigateInput): Promise<{ threadId: string; permissionMode: EffectiveMode }> {
    const run = this.runOrThrow(i.runId);
    const env = this.envOf(run);
    const sourceThreadId = i.threadId ?? run.source.threadId ?? null;
    const src = sourceThreadId ? await this.source(sourceThreadId) : null;
    const projectId = src?.projectId ?? i.projectId;
    if (!projectId) throw new Error(`no project for the investigation of ${run.id}: the run was not started from a thread, so pass projectId`);
    const input = await this.runInput(run, env, { host: i.host, node: i.node }, BUDGETS.investigate, undefined);
    const hosts = [...new Set((input.failures ?? []).map((f) => f.host))];
    const on = hosts.length === 0 ? "all hosts" : hosts.length > HOSTS_IN_TITLE ? `${hosts.length} hosts` : hosts.join(", ");
    const args: DispatchSpawnArgs = {
      projectId, prompt: renderContext(input), title: `Investigate ${run.playbook} on ${on}`, environment: environmentOf(src),
      permissionMode: this.readonlyRejected ? "accept-edits" : "readonly",
      ...(src && src.canSpawnChild !== false ? { parentThreadId: src.id } : {}),
      ...(src?.providerId ? { providerId: src.providerId } : {}),
      ...(src?.model ? { model: src.model } : {}),
      pluginMetadata: { playbooks: { runId: run.id, host: i.host ?? null, nodeId: i.node ?? null, kind: "investigation" } },
    };
    const thread = await this.spawnThread(args);
    const scope = i.host && i.node ? "cell" : i.node ? "task" : "run";
    this.d.store.insertInvestigation({ runId: run.id, threadId: thread.id, host: i.host ?? null, nodeId: i.node ?? null, scope, permissionMode: thread.permissionMode });
    this.d.onRunChanged(run.id);
    return { threadId: thread.id, permissionMode: thread.permissionMode };
  }

  onThreadIdle(threadId: string, lastAssistantText: string | null): void {
    this.patch(threadId, { status: "idle", summary: oneLine(lastAssistantText, LIMITS.lastLine) });
  }

  onThreadFailed(threadId: string): void {
    this.patch(threadId, { status: "failed" });
  }

  onThreadDeleted(threadId: string): void {
    this.patch(threadId, { status: "deleted" });
  }

  private patch(threadId: string, patch: { status: string; summary?: string | null }): void {
    const row = this.d.store.investigationByThread(threadId);
    if (!row) return;
    this.d.store.updateInvestigation(row.id, patch);
    this.d.onRunChanged(row.runId);
  }

  /**
   * Spawn with two recoveries: a host that refuses the parent (a thread that cannot have children) gets a top-level
   * thread, and an installed SDK without a `readonly` mode gets accept-edits (the prompt still says read-only).
   */
  private async spawnThread(args: DispatchSpawnArgs): Promise<{ id: string; permissionMode: EffectiveMode }> {
    try {
      const { id } = await this.d.sdk.threads.spawn(args);
      return { id, permissionMode: args.permissionMode ?? "accept-edits" };
    } catch (e) {
      if (args.parentThreadId && isParentRejected(e)) {
        this.d.log("warn", `parent thread ${args.parentThreadId} rejected; spawning top-level: ${message(e)}`);
        const { parentThreadId: _parent, ...rest } = args;
        return this.spawnThread(rest);
      }
      if (args.permissionMode === "readonly" && isReadonlyRejection(e)) {
        this.readonlyRejected = true;
        this.d.log("warn", `readonly permission mode rejected; spawning the investigation with accept-edits: ${message(e)}`);
        return this.spawnThread({ ...args, permissionMode: "accept-edits" });
      }
      throw e;
    }
  }

  private async source(threadId: string): Promise<SourceThread | null> {
    try {
      return await this.d.sdk.threads.get({ threadId });
    } catch (e) {
      this.d.log("warn", `source thread ${threadId} could not be read; spawning top-level: ${message(e)}`);
      return null;
    }
  }

  private runOrThrow(runId: string): RunRow {
    const run = this.d.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run;
  }

  private envOf(run: RunRow): PlaybooksEnvRow {
    const env = this.d.store.getEnv(run.envId);
    if (!env) throw new Error(`unknown environment ${run.envId}`);
    return env;
  }

  private async input(ref: string, runId: string | undefined, instruction: string | undefined, budget: number): Promise<ContextInput> {
    const runRef = ref.startsWith("run_") ? parseRunRef(ref) : null;
    if (runRef) {
      const run = this.runOrThrow(runRef.runId);
      return this.runInput(run, this.envOf(run), { host: runRef.host, node: runRef.node }, budget, instruction);
    }
    const t = parseTarget(ref);
    if (!t) throw new Error(`unknown target ${ref}`);
    const env = this.d.envs.get(t.env);
    if (!env) throw new Error(`unknown environment ${t.env}`);
    const res = t.path ? await this.d.library.summary(env.slug, t.path) : null;
    if (res && "notFound" in res) throw new Error(`unknown target ${ref}`);
    if (res && "unreachable" in res) throw new Error(res.unreachable);
    const run = runId ? await this.d.runs.view(runId) : null;
    const cellMessages = run && t.node ? Object.fromEntries(failedCells(run, this.d.store.listEvents(run.runId, { cursor: 0, limit: ALL_EVENTS }), { node: t.node }).map((f) => [f.host, f.msg])) : undefined;
    return {
      target: t, env, head: this.d.envs.health(env.id)?.head ?? null, summary: res?.summary ?? null, content: res?.content ?? null, run,
      ...(cellMessages ? { cellMessages } : {}), ...(instruction ? { instruction } : {}), budget,
    };
  }

  private async runInput(run: RunRow, env: PlaybooksEnvRow, scope: { host?: string | undefined; node?: string | undefined }, budget: number, instruction: string | undefined): Promise<ContextInput> {
    const res = await this.d.library.summary(env.slug, run.playbook).catch(() => null);
    const summary = res && "summary" in res ? res.summary : null;
    const content = res && "summary" in res ? res.content : null;
    const view = await this.d.runs.view(run.id);
    const failures = view ? failedCells(view, this.d.store.listEvents(run.id, { cursor: 0, limit: ALL_EVENTS }), scope) : [];
    const node = scope.node ?? (failures.length === 1 ? failures[0]!.nodeId : undefined);
    return {
      target: { runId: run.id, ...(scope.host ? { host: scope.host } : {}), ...(node ? { node } : {}) }, env, head: this.d.envs.health(env.id)?.head ?? null,
      summary, content, run: view, failures, ...(instruction ? { instruction } : {}), budget,
    };
  }
}

const environmentOf = (src: SourceThread | null): SpawnEnvironment => (src?.environmentId ? { type: "reuse", environmentId: src.environmentId } : { type: "project-default" });
