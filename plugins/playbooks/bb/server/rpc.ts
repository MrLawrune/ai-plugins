// RPC handlers: thin adapters from the contract to the services. Unknown targets are data, not errors.
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { open } from "node:fs/promises";
import type { CellDto, EnvSettingsDto, RpcContract, RunSummaryDto } from "../schemas.ts";
import { eventsForRow, isIgnoredFailure, rowOfNode } from "./runview.ts";
import { toGraph } from "../shared/graph.ts";
import type { LibraryService } from "./library.ts";
import { configurationGap, type EnvService } from "./envs.ts";
import type { RunService } from "./runs.ts";
import type { PlaybooksEnvRow, RunRow, Store } from "./store.ts";

/** DispatchService's surface; `null` (tests) makes the dispatch handlers throw `not_implemented`. */
export interface DispatchLike {
  spawn(input: { target: string; runId?: string | undefined; instruction: string; projectId: string; threadId?: string | undefined }): Promise<{ threadId: string }>;
  prompt(input: { target: string; runId?: string | undefined; instruction: string }): Promise<{ prompt: string }>;
  investigate(input: { runId: string; host?: string | undefined; node?: string | undefined; threadId?: string | undefined; projectId?: string | undefined }): Promise<{ threadId: string; permissionMode: "readonly" | "accept-edits" }>;
}

export interface RpcDeps {
  store: Store;
  envs: EnvService;
  library: LibraryService;
  runs: RunService;
  dispatch: DispatchLike | null;
  /** Reads a slice of a run's local stream log; defaults to the filesystem. */
  readLog?(path: string, offset: number, bytes: number): Promise<{ text: string; size: number }>;
}

const OPEN = new Set(["queued", "starting", "running"]);
const RESULT_KINDS = new Set(["host_ok", "host_failed", "host_unreachable", "host_skipped", "item_ok", "item_failed", "item_skipped"]);
const HUMAN_SURFACES: ReadonlySet<string> = new Set(["card", "panel", "page"]);
/** `run.events` responses stay under this many bytes of event JSON (the CLI's page budget); the rest is paged with nextCursor. */
export const EVENTS_PAGE_BYTES = 512 * 1024;

export async function readSlice(path: string, offset: number, bytes: number): Promise<{ text: string; size: number }> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.max(0, Math.min(bytes, size - offset)));
    await fh.read(buf, 0, buf.length, offset);
    return { text: buf.toString("utf8"), size };
  } finally {
    await fh.close();
  }
}

/** Per-run host counts from the recap (null without one); "failed" includes unreachable, matching the card's failed count. */
export function recapCounts(recap: RunRow["recap"]): Pick<RunSummaryDto, "hosts" | "failedHosts" | "changedHosts"> {
  if (!recap) return { hosts: null, failedHosts: null, changedHosts: null };
  const all = Object.values(recap);
  return {
    hosts: all.length,
    failedHosts: all.filter((h) => h.failures > 0 || h.unreachable > 0).length,
    changedHosts: all.filter((h) => h.changed > 0).length,
  };
}

export function createRpcHandlers(d: RpcDeps) {
  const env = (slug: string): PlaybooksEnvRow => {
    const e = d.envs.get(slug);
    if (!e) throw new Error(`unknown environment ${slug}`);
    return e;
  };
  const runSummary = (r: RunRow): RunSummaryDto | null => {
    const e = d.store.getEnv(r.envId);
    if (!e) return null;
    return {
      id: r.id, env: d.envs.badge(e), playbook: r.playbook, playbookName: r.playbookName, status: r.status, requestedAt: r.requestedAt,
      startedAt: r.startedAt, endedAt: r.endedAt, source: r.source, check: r.spec.check, lastLine: r.lastLine, ...recapCounts(r.recap),
    };
  };
  const summaries = (rows: RunRow[]): RunSummaryDto[] => rows.map(runSummary).filter((r): r is RunSummaryDto => r !== null);
  const settingsDto = (e: PlaybooksEnvRow): EnvSettingsDto => {
    const { createdAt: _createdAt, ...rest } = e;
    return { ...rest, health: d.envs.health(e.id) };
  };
  const dispatch = (): DispatchLike => {
    if (!d.dispatch) throw new Error("not_implemented");
    return d.dispatch;
  };
  // The surface class is decided here, not by the caller: RPC is only reachable from BB's own UI, so an agent cannot
  // claim a human surface and skip the form policy applies to cli/tool runs.
  const runInput = (i: { env: string; file: string; spec: RpcRunSpec; source: { surface: RpcSurface; threadId: string | null } }) => {
    if (!HUMAN_SURFACES.has(i.source.surface)) throw new Error(`invalid_input: source.surface must be card, panel, or page (agents start runs with \`bb playbooks run\`)`);
    return { envId: env(i.env).id, playbook: i.file, spec: i.spec, source: i.source };
  };

  return {
    async overview() {
      const running = d.store.listOpenRuns();
      return {
        envs: d.envs.list().map((e) => ({
          env: d.envs.badge(e),
          health: !e.enabled ? "disabled" as const : d.envs.health(e.id)?.code ?? "ok" as const,
          running: running.filter((r) => r.envId === e.id).length,
        })),
      };
    },
    async "playbook.summary"({ env: slug, file, threadId, force }) {
      const e = d.envs.get(slug);
      if (!e) return { found: false as const, reason: "unknown-env" as const, message: `Unknown environment ${slug}.` };
      const res = await d.library.summary(slug, file, { ...(threadId ? { threadId } : {}), ...(force ? { force } : {}) });
      if ("notFound" in res) return { found: false as const, reason: "not-found" as const, message: `${file} was not found in ${e.name}.` };
      if ("unreachable" in res) return { found: false as const, reason: "unreachable" as const, message: res.unreachable };
      const last = d.store.listRuns({ envId: e.id, playbook: file, limit: 1 })[0];
      return { found: true as const, summary: res.summary, lastRun: last ? runSummary(last) : null };
    },
    async "playbook.raw"({ env: slug, file }) {
      const res = await d.library.summary(slug, file);
      if (!("summary" in res)) throw new Error("unreachable" in res ? res.unreachable : `${file} not found`);
      return { content: res.content };
    },
    async "playbook.graph"({ env: slug, file, runId }) {
      const res = await d.library.summary(slug, file);
      if (!("summary" in res)) return { nodes: [], edges: [] };
      return toGraph(res.summary, runId ? await d.runs.view(runId) : null);
    },
    async "library.list"({ env: slug }) { return { entries: await d.library.list(slug) }; },
    async "inventories.list"({ env: slug }) { return { inventories: await d.library.discoverInventories(slug) }; },
    async "inventories.resolve"({ env: slug, path }) { return d.library.resolveInventory(slug, path); },
    async "credrefs.list"({ env: slug }) { return { credRefs: d.store.listCredRefs(env(slug).id) }; },
    async "credrefs.save"({ env: slug, ...rest }) {
      return { credRef: d.store.upsertCredRef({ envId: env(slug).id, ...rest }) };
    },
    async "credrefs.delete"({ id }) { d.store.deleteCredRef(id); return { deleted: true as const }; },
    async "run.prepare"(i) { return d.runs.prepare({ ...runInput(i), noConfirm: false }); },
    async "run.start"(i) {
      const base = runInput(i);
      const prepared = await d.runs.prepare({ ...base, noConfirm: false });
      if (!prepared.allowed) throw new Error(prepared.reason);
      const row = await d.runs.start({
        envId: base.envId, playbook: i.file, spec: i.spec, source: { ...i.source, scheduleId: null }, approval: prepared.confirm, typed: i.typed,
      });
      return { runId: row.id };
    },
    async "run.cancel"({ runId, force }) { return d.runs.cancel(runId, force); },
    async "run.view"({ runId }) {
      const view = await d.runs.view(runId);
      return view ? { found: true as const, view, spec: d.store.getRun(runId)?.spec ?? null } : { found: false as const };
    },
    async "run.events"({ runId, cursor, limit, host, node, failedOnly, light }) {
      const rows = d.store.listEvents(runId, { cursor, limit, ...(host ? { host } : {}), ...(node ? { node } : {}), ...(failedOnly ? { failedOnly } : {}) });
      const events = light ? rows.map((e) => ({ ...e, res: null, diff: null, stdout: null })) : rows;
      // Byte-bounded page: at least one event, then stop before the budget is exceeded.
      let bytes = 0;
      const kept: typeof events = [];
      for (const e of events) {
        bytes += Buffer.byteLength(JSON.stringify(e));
        if (bytes > EVENTS_PAGE_BYTES && kept.length > 0) break;
        kept.push(e);
      }
      const last = kept.length ? kept[kept.length - 1]!.seq : cursor;
      const nextCursor = kept.length < events.length || events.length === limit ? last : null;
      return { events: kept, cursor: last, nextCursor };
    },
    async "run.cell"({ runId, host, node, playIndex, taskIndex }): Promise<CellDto> {
      // The row is picked by ordinal, as buildRunView numbers it, so same-named tasks and plays stay apart.
      const view = await d.runs.view(runId);
      const row = playIndex !== undefined && taskIndex !== undefined ? { playIndex, taskIndex } : view ? rowOfNode(view, node) : null;
      const events = row ? eventsForRow(d.store.listEvents(runId, { cursor: 0, limit: 10_000 }), row.playIndex, row.taskIndex) : [];
      const result = events.filter((e) => e.host === host && RESULT_KINDS.has(e.kind)).pop();
      const started = events.find((e) => e.kind === "task_start");
      return {
        msg: result?.msg ?? null, res: result?.res ?? null, diff: result?.diff ?? null, stdout: result?.stdout ?? null,
        durationMs: result && started ? Math.max(0, result.at - started.at) : null, ignored: result ? isIgnoredFailure(result) : false,
      };
    },
    async "run.raw"({ runId, offset, bytes }) {
      const run = d.store.getRun(runId);
      if (!run?.logPath) return { text: "", offset, size: 0, read: 0 };
      const { text, size } = await (d.readLog ?? readSlice)(run.logPath, offset, bytes);
      return { text, offset, size, read: Buffer.byteLength(text) };
    },
    async "runs.list"({ env: slug, file, threadId, limit }) {
      const e = slug ? env(slug) : null;
      return { runs: summaries(d.store.listRuns({ ...(e ? { envId: e.id } : {}), ...(file ? { playbook: file } : {}), ...(threadId ? { threadId } : {}), limit })) };
    },
    async "run.investigate"(i) { return dispatch().investigate(i); },
    async "dispatch.spawn"(i) { return dispatch().spawn(i); },
    async "dispatch.prompt"(i) { return dispatch().prompt(i); },
    async "thread.playbooks"({ threadId }) {
      const files = d.library.threadFiles(threadId).flatMap((f) => {
        const e = d.store.getEnv(f.envId);
        return e ? [{ env: d.envs.badge(e), path: f.path, name: f.path.split("/").pop() ?? f.path }] : [];
      });
      const runs = d.store.listRuns({ limit: 200 }).filter((r) => r.source.threadId === threadId);
      return { files, runs: summaries(runs) };
    },
    async "settings.get"() {
      const envs = d.envs.list();
      return { envs: envs.map(settingsDto), gap: configurationGap(envs, d.envs.healthMap()) };
    },
    async "env.save"(input) { return { env: settingsDto(d.envs.save(input)) }; },
    async "env.delete"({ id }) { d.envs.delete(id); return { deleted: true as const }; },
    async "env.test"({ id }) { return { health: await d.envs.test(id) }; },
  } satisfies PluginRpcHandlers<RpcContract>;
}

type RpcRunSpec = Parameters<RunService["prepare"]>[0]["spec"];
type RpcSurface = "card" | "panel" | "page";
