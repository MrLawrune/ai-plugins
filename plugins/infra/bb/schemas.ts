// RPC contract shared by the backend and (type-only) the frontend.
// Inputs are validated at the wire boundary; outputs are typed DTOs built by the service.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { CertInfo } from "./server/providers/proxmox/tls.ts";
import type {
  BackupEntry, ConnectionHealth, GuestDetail, GuestState, HealthCode, HostDetail, HostState, MetricPoint, MetricRange, MetricSeries, RunState, StoragePool, TaskEntry,
} from "./server/providers/types.ts";
import type { ChangeKind, ConnectionRow, EnvKind, InfraEnvRow } from "./server/store.ts";
import { CHANNELS, ENV_KINDS, RULES_MAX } from "./shared/constants.ts";
import { parseTarget, SLUG_RE } from "./server/targets.ts";

export type { BackupEntry, CertInfo, ConnectionHealth, EnvKind, GuestDetail, GuestState, HealthCode, HostDetail, HostState, InfraEnvRow, MetricPoint, MetricRange, MetricSeries, RunState, StoragePool, TaskEntry };

export interface EnvBadgeDto { slug: string; name: string; kind: EnvKind; color: string }
export interface ActivityDto { threadId: string; itemId: string; target: string; command: string; phase: "started" | "completed"; exitCode: number | null; at: number }
export interface ChangeDto { target: string; kind: ChangeKind; detail: string; threadId: string | null; at: number }
export interface EnvSummary {
  env: EnvBadgeDto;
  hosts: { up: number; total: number };
  guests: { running: number; total: number };
  health: HealthCode;
  staleSince: number | null;
  activeThreads: string[];
}
export interface EnvViewDto {
  env: EnvBadgeDto;
  health: HealthCode;
  connections: { id: string; label: string; health: ConnectionHealth }[];
  hosts: HostState[];
  guests: (GuestState & { ips: string[]; active: boolean })[];
  storage: StoragePool[];
  updatedAt: number | null;
  recentActivity: ActivityDto[];
}
export interface ThreadTargetDto { target: string; env: EnvBadgeDto; label: string; kind: "env" | "host" | "guest"; state: string | null; running: boolean; lastAt: number }
export type ConnectionDto = Omit<ConnectionRow, "caPem"> & { hasCaPem: boolean; hasSecret: boolean; health: ConnectionHealth | null };
export type NotFound = { found: false };

const target = z.string().max(200).refine((s) => parseTarget(s) !== null, "invalid target");
const out = <T>() => z.custom<T>(() => true);

const envSave = z.object({
  id: z.string().max(64).optional(),
  slug: z.string().regex(SLUG_RE, "slug must be 1-32 lowercase letters, digits, or dashes"),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(ENV_KINDS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  pollSeconds: z.number().int().min(5).max(300),
  rules: z.string().max(RULES_MAX),
  exportDir: z.string().max(500),
  /** Minutes between guest-IP sweeps; 0 turns them off. */
  ipRefreshMinutes: z.number().int().min(0).max(1440).optional(),
  /** Absolute path on the BB server to an existing conventions file (AGENTS.md, runbook). */
  conventionsPath: z.string().max(500).refine((p) => p === "" || p.startsWith("/"), "use an absolute path on the BB server").optional(),
}).strict();

const connectionSave = z.object({
  id: z.string().max(64).optional(),
  envId: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(60),
  baseUrl: z.string().url().refine((u) => u.startsWith("https://"), "use an https:// URL (port 8006 by default)"),
  authKind: z.enum(["token", "password"]),
  username: z.string().trim().min(1).max(200),
  tlsMode: z.enum(["pinned", "ca", "insecure"]),
  tlsFingerprint: z.string().max(200),
  caPem: z.string().max(20_000).optional(),
  enabled: z.boolean(),
  /** Browser-reachable Proxmox web UI (e.g. through a reverse proxy); empty = use baseUrl. */
  webUrl: z.union([z.literal(""), z.string().url().refine((u) => u.startsWith("https://"), "use an https:// URL")]).optional(),
  /** Write-only. Omit or empty to keep the stored secret. */
  secret: z.string().max(2000).optional(),
}).strict();

export type EnvSaveInput = z.infer<typeof envSave>;
export type ConnectionSaveInput = z.infer<typeof connectionSave>;
export const ASK_INTENTS = ["ask", "investigate", "troubleshoot"] as const;
export type AskIntent = (typeof ASK_INTENTS)[number];

export const rpcContract = defineRpcContract({
  overview: { input: z.object({}).strict(), output: out<{ envs: EnvSummary[] }>() },
  env: { input: z.object({ slug: z.string().regex(SLUG_RE) }).strict(), output: out<NotFound | ({ found: true } & EnvViewDto)>() },
  host: {
    input: z.object({ target }).strict(),
    output: out<NotFound | { found: true; env: EnvBadgeDto; detail: HostDetail; guests: GuestState[]; tasks: TaskEntry[]; activity: ActivityDto[]; webUrl: string }>(),
  },
  guest: {
    input: z.object({ target }).strict(),
    output: out<NotFound | { found: true; env: EnvBadgeDto; detail: GuestDetail; activity: ActivityDto[]; changes: ChangeDto[]; webUrl: string }>(),
  },
  guestSummary: {
    input: z.object({ target }).strict(),
    output: out<NotFound | { found: true; env: EnvBadgeDto; guest: GuestState; ips: string[]; running: boolean }>(),
  },
  hostSummary: {
    input: z.object({ target }).strict(),
    output: out<NotFound | { found: true; env: EnvBadgeDto; host: HostState; guests: { running: number; total: number }; running: boolean }>(),
  },
  guestExtras: {
    input: z.object({ target, tab: z.enum(["tasks", "backups"]) }).strict(),
    output: out<NotFound | { found: true; tasks?: TaskEntry[]; backups?: BackupEntry[] }>(),
  },
  metrics: {
    input: z.object({ target, range: z.enum(["hour", "day", "week"]) }).strict(),
    output: out<NotFound | { found: true; series: MetricSeries }>(),
  },
  activity: {
    input: z.object({ envSlug: z.string().regex(SLUG_RE).optional(), target: target.optional(), threadId: z.string().max(100).optional(), limit: z.number().int().min(1).max(500) }).strict(),
    output: out<{ items: ActivityDto[]; changes: ChangeDto[] }>(),
  },
  threadTargets: { input: z.object({ threadId: z.string().min(1).max(100) }).strict(), output: out<{ targets: ThreadTargetDto[] }>() },
  runningThreads: { input: z.object({}).strict(), output: out<{ threads: { threadId: string; targets: string[] }[] }>() },
  askPrompt: { input: z.object({ target, intent: z.enum(ASK_INTENTS) }).strict(), output: out<NotFound | { found: true; prompt: string }>() },
  settingsGet: { input: z.object({}).strict(), output: out<{ envs: InfraEnvRow[]; connections: ConnectionDto[] }>() },
  envSave: { input: envSave, output: out<{ env: InfraEnvRow }>() },
  envDelete: { input: z.object({ id: z.string().min(1).max(64) }).strict(), output: out<{ deleted: true }>() },
  connectionSave: { input: connectionSave, output: out<{ connection: ConnectionDto }>() },
  connectionDelete: { input: z.object({ id: z.string().min(1).max(64) }).strict(), output: out<{ deleted: true }>() },
  connectionProbe: {
    input: z.object({ baseUrl: z.string().url() }).strict(),
    output: out<{ ok: true; cert: CertInfo } | { ok: false; error: string }>(),
  },
  connectionTest: { input: z.object({ id: z.string().min(1).max(64) }).strict(), output: out<{ health: ConnectionHealth | null; version: string | null }>() },
});

export type RpcContract = typeof rpcContract;

export { CHANNELS };
export interface EventsSignal { events: { env: EnvBadgeDto; target: string; kind: ChangeKind; detail: string; threadId: string | null }[] }
