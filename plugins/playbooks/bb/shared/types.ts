// Shared data shapes (spec §5.1, §5.3). No Node or zod imports: the browser bundle loads this.
import type { EnvKind } from "./constants.ts";

export interface PlaybookSummary {
  env: string; path: string; // env slug, path relative to repoPath
  hash: string; // sha256 of content; cache key
  name: string; // first play name or file stem
  plays: PlaySummary[];
  imports: { path: string; line: number }[]; // import_playbook
  warnings: Warning[]; // unnamed tasks, unknown keys, deprecated with_*
  error?: { line: number; message: string }; // parse failure → plays = []
  counts: { plays: number; steps: number; handlers: number; roles: number };
  targets: string[]; // distinct host patterns across plays
}

export interface PlaySummary {
  id: string; // "p0"
  name: string; line: number; endLine: number;
  hosts: string; become: boolean | null; gatherFacts: boolean | null;
  serial: string | null; strategy: string | null; tags: string[];
  vars: { keys: string[]; files: string[] };
  roles: { id: string; name: string; when: string | null; tags: string[] }[]; // "p0/rcommon"
  preTasks: TaskSummary[]; tasks: TaskSummary[]; postTasks: TaskSummary[];
  handlers: TaskSummary[]; // ids "p0/h0"…
}

export interface TaskSummary {
  id: string; // "p0/t1", "p0/t3/t0" inside a block
  line: number; endLine: number;
  name: string | null;
  plain: string; // plain-language line (name, else verb table)
  action: string; // FQCN or short module, or "block" / "include_tasks" …
  args: { key: string; value: string }[]; // values stringified ≤ 120 chars
  when: string | null; loop: string | null;
  register: string | null; notify: string[];
  tags: string[]; become: boolean | null; delegateTo: string | null;
  ignoreErrors: boolean;
  children?: { block: TaskSummary[]; rescue: TaskSummary[]; always: TaskSummary[] };
  include?: { kind: "tasks" | "role" | "playbook"; target: string; static: boolean };
}

export type Warning = { line: number; message: string };

export type RunSpec = {
  inventory: string; limit: string; tags: string[]; skipTags: string[];
  extraVars: Record<string, unknown>; credRefId: string | null;
  check: boolean; diff: boolean; verbosity: 0 | 1 | 2 | 3 | 4; branch: string | null;
};

export type RunStatus = "queued" | "starting" | "running" | "success" | "failed" | "canceled" | "unknown";

// RunEventRow minus runId; the store adds it.
export interface RunEvent {
  seq: number; at: number;
  kind: "playbook_start" | "play_start" | "task_start" | "host_start"
    | "host_ok" | "host_failed" | "host_unreachable" | "host_skipped"
    | "item_ok" | "item_failed" | "item_skipped" | "stats" | "log" | "error";
  play: string | null; task: string | null; taskAction: string | null;
  nodeId: string | null; // TaskSummary.id matched by play name + task name + order
  host: string | null; changed: boolean; failed: boolean;
  msg: string | null; // ≤ 2 KB
  res: string | null; // JSON ≤ 8 KB, fetched on demand
  diff: string | null; // ≤ 64 KB
  stdout: string | null; // ≤ 4 KB
  source: "events" | "text";
}

export type CellState = "pending" | "running" | "ok" | "changed" | "failed" | "unreachable" | "skipped";

export type HostStats = { ok: number; changed: number; failures: number; unreachable: number; skipped: number; rescued: number; ignored: number };

export type EnvHealthCode = "ok" | "unreachable" | "no-ansible" | "no-repo" | "degraded" | "disabled";

export type EnvBadgeDto = { slug: string; name: string; kind: EnvKind; color: string };

export type RunView = {
  runId: string;
  status: RunStatus;
  playbook: string;
  env: EnvBadgeDto;
  plays: { id: string; name: string; tasks: { nodeId: string | null; name: string; cells: Record<string, CellState> }[] }[];
  hosts: string[];
  counters: { ok: number; changed: number; failed: number; unreachable: number; skipped: number };
  recap: Record<string, HostStats> | null;
  investigations: { threadId: string; host: string | null; nodeId: string | null; status: string; summary: string | null; permissionMode: string | null }[];
  startedAt: number | null;
  endedAt: number | null;
  lastLine: string | null;
};
