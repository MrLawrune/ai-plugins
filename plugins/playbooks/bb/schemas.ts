// RPC contract shared by the backend and (type-only) the frontend.
// Inputs are validated at the wire boundary; outputs are typed DTOs built by the handlers.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { EnvHealth } from "./server/envs.ts";
import type { LibraryEntry } from "./server/library.ts";
import type { Prepared } from "./server/runs.ts";
import type { CredRefRow, InventoryRow, RunEventRow, RunSourceRow } from "./server/store.ts";
import { isSafeRelativePath, NODE_RE, SLUG_RE } from "./server/targets.ts";
import { ENV_KINDS, RULES_MAX, type EnvKind } from "./shared/constants.ts";
import type { GraphEdge, GraphNode } from "./shared/graph.ts";
import type { CellState, EnvBadgeDto, EnvHealthCode, PlaybookSummary, RunSpec, RunStatus, RunView } from "./shared/types.ts";

export type { EnvBadgeDto, EnvHealth, EnvHealthCode, EnvKind, LibraryEntry, RunView };

export interface RunSummaryDto {
  id: string; env: EnvBadgeDto; playbook: string; playbookName: string; status: RunStatus;
  requestedAt: number; startedAt: number | null; endedAt: number | null; source: RunSourceRow; check: boolean; lastLine: string | null;
  /** From the run's recap; null while there is none. failedHosts counts failed or unreachable hosts. */
  hosts: number | null; failedHosts: number | null; changedHosts: number | null;
}
export interface EnvSettingsDto {
  id: string; slug: string; name: string; kind: EnvKind; color: string; rules: string; controlHost: string; hostId: string | null;
  repoPath: string; inventoryRoot: string; runnerKind: string; agentApproval: string; defaultCheck: boolean; infraEnvSlug: string | null;
  enabled: boolean; health: EnvHealth | null;
}
export type SummaryFound = { found: true; summary: PlaybookSummary; lastRun: RunSummaryDto | null };
export type SummaryMissing = { found: false; reason: "not-found" | "unreachable" | "unknown-env"; message: string };
export type CellDto = { msg: string | null; res: string | null; diff: string | null; stdout: string | null; durationMs: number | null; ignored: boolean };
export type { CellState, GraphEdge, GraphNode };

const out = <T>() => z.custom<T>(() => true);

const envSlug = z.string().regex(SLUG_RE, "slug must be 1-32 lowercase letters, digits, or dashes");
const relPath = z.string().max(300).refine(isSafeRelativePath, "use a relative path without '..'");
const nodeId = z.string().regex(NODE_RE);
const runId = z.string().regex(/^run_[0-9A-Za-z]{6,32}$/);
const threadId = z.string().min(1).max(64);
const absPath = (m: string) => z.string().max(500).refine((p) => p.startsWith("/"), m);

const runSpec = z.object({
  inventory: z.string().max(300),
  limit: z.string().max(300),
  tags: z.array(z.string().max(100)).max(50),
  skipTags: z.array(z.string().max(100)).max(50),
  extraVars: z.record(z.string(), z.unknown()),
  credRefId: z.string().max(64).nullable(),
  check: z.boolean(),
  diff: z.boolean(),
  verbosity: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  branch: z.string().max(200).nullable(),
}).strict();

// RPC callers are the human surfaces; agent surfaces (cli, tool) only enter through the CLI, so the policy's agent gate cannot be claimed away.
const runSource = z.object({ surface: z.enum(["card", "panel", "page"]), threadId: z.string().max(64).nullable() }).strict();

const envSave = z.object({
  id: z.string().max(64).optional(),
  slug: envSlug,
  name: z.string().trim().min(1).max(80),
  kind: z.enum(ENV_KINDS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  rules: z.string().max(RULES_MAX),
  controlHost: z.string().min(1).max(200).refine((h) => h !== "local", 'use an ssh alias or host name; "local" is not supported yet'),
  hostId: z.string().max(64).nullable(),
  repoPath: absPath("use an absolute path on the control host"),
  inventoryRoot: z.string().max(500).refine((p) => p === "" || p.startsWith("/"), "use an absolute path or leave empty"),
  runnerKind: z.literal("ssh"),
  agentApproval: z.enum(["form", "none"]),
  defaultCheck: z.boolean(),
  infraEnvSlug: envSlug.nullable(),
  enabled: z.boolean(),
}).strict();

const credRefSave = z.object({
  env: envSlug,
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1).max(80),
  sshUser: z.string().max(100).nullable(),
  keyPath: z.string().max(500).nullable(),
  becomeMethod: z.string().max(40).nullable(),
  vaultPasswordFile: z.string().max(500).nullable(),
  ansibleCfg: z.string().max(500).nullable(),
}).strict();

export type EnvSaveInput = z.infer<typeof envSave>;
export type RunSpecInput = z.infer<typeof runSpec>;
export type RunSourceInput = z.infer<typeof runSource>;

const runTarget = z.object({ env: envSlug, file: relPath, spec: runSpec, source: runSource }).strict();
const dispatchTarget = z.string().max(400);

export const rpcContract = defineRpcContract({
  overview: { input: z.object({}).strict(), output: out<{ envs: { env: EnvBadgeDto; health: EnvHealthCode; running: number }[] }>() },
  "playbook.summary": {
    input: z.object({ env: envSlug, file: relPath, threadId: threadId.optional(), force: z.boolean().optional() }).strict(),
    output: out<SummaryFound | SummaryMissing>(),
  },
  "playbook.raw": { input: z.object({ env: envSlug, file: relPath }).strict(), output: out<{ content: string }>() },
  "playbook.graph": {
    input: z.object({ env: envSlug, file: relPath, runId: runId.optional() }).strict(),
    output: out<{ nodes: GraphNode[]; edges: GraphEdge[] }>(),
  },
  "library.list": { input: z.object({ env: envSlug }).strict(), output: out<{ entries: LibraryEntry[] }>() },
  "inventories.list": { input: z.object({ env: envSlug }).strict(), output: out<{ inventories: InventoryRow[] }>() },
  "inventories.resolve": {
    input: z.object({ env: envSlug, path: relPath }).strict(),
    output: out<{ groups: string[]; hosts: string[] } | null>(),
  },
  "credrefs.list": { input: z.object({ env: envSlug }).strict(), output: out<{ credRefs: CredRefRow[] }>() },
  "credrefs.save": { input: credRefSave, output: out<{ credRef: CredRefRow }>() },
  "credrefs.delete": { input: z.object({ id: z.string().min(1).max(64) }).strict(), output: out<{ deleted: true }>() },
  "run.prepare": { input: runTarget, output: out<Prepared>() },
  "run.start": { input: runTarget.extend({ typed: z.string().max(64).optional() }).strict(), output: out<{ runId: string }>() },
  "run.cancel": { input: z.object({ runId, force: z.boolean() }).strict(), output: out<{ ok: boolean }>() },
  "run.view": { input: z.object({ runId }).strict(), output: out<{ found: true; view: RunView; spec: RunSpec | null } | { found: false }>() },
  "run.events": {
    input: z.object({
      runId, cursor: z.number().int().min(0), limit: z.number().int().min(1).max(1000),
      host: z.string().max(128).optional(), node: nodeId.optional(), failedOnly: z.boolean().optional(),
      /** Drop res, diff, and stdout from each event (the matrix and failure lists need none of them), so far more fit a page. */
      light: z.boolean().optional(),
    }).strict(),
    output: out<{ events: RunEventRow[]; cursor: number; nextCursor: number | null }>(),
  },
  "run.cell": { input: z.object({ runId, host: z.string().min(1).max(128), node: nodeId, playIndex: z.number().int().min(0).max(10_000).optional(), taskIndex: z.number().int().min(0).max(10_000).optional() }).strict(), output: out<CellDto>() },
  "run.raw": {
    input: z.object({ runId, offset: z.number().int().min(0), bytes: z.number().int().min(1).max(262_144) }).strict(),
    output: out<{ text: string; offset: number; size: number; read: number }>(),
  },
  "runs.list": {
    input: z.object({ env: envSlug.optional(), file: relPath.optional(), threadId: threadId.optional(), limit: z.number().int().min(1).max(200) }).strict(),
    output: out<{ runs: RunSummaryDto[] }>(),
  },
  "run.investigate": {
    input: z.object({ runId, host: z.string().max(128).optional(), node: nodeId.optional(), threadId: threadId.optional(), projectId: z.string().min(1).max(64).optional() }).strict(),
    output: out<{ threadId: string; permissionMode: "readonly" | "accept-edits" }>(),
  },
  "dispatch.spawn": {
    input: z.object({ target: dispatchTarget, runId: runId.optional(), instruction: z.string().max(4000), projectId: z.string().min(1).max(64), threadId: threadId.optional() }).strict(),
    output: out<{ threadId: string }>(),
  },
  "dispatch.prompt": {
    input: z.object({ target: dispatchTarget, runId: runId.optional(), instruction: z.string().max(4000) }).strict(),
    output: out<{ prompt: string }>(),
  },
  "thread.playbooks": {
    input: z.object({ threadId }).strict(),
    output: out<{ files: { env: EnvBadgeDto; path: string; name: string }[]; runs: RunSummaryDto[] }>(),
  },
  "settings.get": { input: z.object({}).strict(), output: out<{ envs: EnvSettingsDto[]; gap: string | null }>() },
  "env.save": { input: envSave, output: out<{ env: EnvSettingsDto }>() },
  "env.delete": { input: z.object({ id: z.string().min(1).max(64) }).strict(), output: out<{ deleted: true }>() },
  "env.test": { input: z.object({ id: z.string().min(1).max(64) }).strict(), output: out<{ health: EnvHealth }>() },
});

export type RpcContract = typeof rpcContract;
