// RPC contract and signals between the server entry and the host entry that talks to each
// environment's Ansible control host over ssh. Shared by bb/host.ts and bb/server.ts.
//
// `overrideCommand` exists on every method for tests only: when set, the host runs that string
// under `bash -lc` on the BB machine instead of the method's own command on the control host.
// The server never sets it and strips it from anything it forwards.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ENV_KEY_RE } from "./host/commands.ts";

// "local" passes the schema so the test path (with overrideCommand) can use it; the host entry rejects it otherwise.
const controlHost = z.string().min(1).max(253).regex(/^[A-Za-z0-9][A-Za-z0-9._@-]*$/, "ssh alias or host name");
const envVars = z.record(z.string().regex(ENV_KEY_RE, "environment variable name"), z.string());
const absPath = z.string().min(1).regex(/^\//, "absolute path").refine((p) => !p.split("/").includes(".."), "no .. segments");
const relPath = z.string().min(1).max(1024).refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.includes("//") && p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."), "relative path without . or .. segments");
const ident = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "run identifier");
const overrideCommand = z.string().optional();
const pid = z.number().int().positive();

export const RUN_MODES = ["runner", "jsonl", "text"] as const;
export type RunMode = (typeof RUN_MODES)[number];

const base = { controlHost, overrideCommand };
const repo = { ...base, repoPath: absPath };

export const hostContract = defineRpcContract({
  probe: {
    experimental_description: "Versions of ansible and ansible-runner, the repo's git HEAD, and the python3 path on the control host. ok needs ansible and python3 (the run supervisor is python).",
    input: z.object(repo),
    output: z.object({ ok: z.boolean(), ansible: z.string().nullable(), runner: z.string().nullable(), head: z.string().nullable(), python3: z.string().nullable(), error: z.string().nullable() }),
  },
  readFile: {
    experimental_description: "Read one repo-relative file. Throws too_large above LIMITS.readFile; hash is sha256 hex of the content.",
    input: z.object({ ...repo, path: relPath }),
    output: z.object({ content: z.string(), hash: z.string(), bytes: z.number().int().nonnegative() }),
  },
  listPlaybooks: {
    experimental_description: "YAML files under the repo excluding roles, group_vars, host_vars, .git, and .bb-runs (first 500, sorted).",
    input: z.object(repo),
    output: z.object({ paths: z.array(z.string()) }),
  },
  hashPlaybooks: {
    experimental_description: "The same YAML files as listPlaybooks with the sha256 (as readFile computes it) and byte size of each, from one ssh session.",
    input: z.object(repo),
    output: z.object({ files: z.array(z.object({ path: z.string(), hash: z.string(), bytes: z.number().int().nonnegative() })) }),
  },
  discoverInventories: {
    experimental_description: "Files and directories up to two levels under an inventory root, as paths relative to that root (first 200, sorted). The server prefixes them to repo-relative paths.",
    input: z.object({ ...base, inventoryRoot: absPath }),
    output: z.object({ entries: z.array(z.object({ path: z.string(), kind: z.enum(["file", "directory"]) })) }),
  },
  resolveInventory: {
    experimental_description: "ansible-inventory --list as raw JSON text.",
    input: z.object({ ...repo, inventory: z.string().min(1) }),
    output: z.object({ json: z.string() }),
  },
  syntaxCheck: {
    experimental_description: "ansible-playbook --syntax-check; output is stdout followed by stderr.",
    input: z.object({ ...repo, playbook: relPath, inventory: z.string().min(1).optional() }),
    output: z.object({ ok: z.boolean(), output: z.string() }),
  },
  listTasks: {
    experimental_description: "ansible-playbook --list-tasks; output is stdout followed by stderr.",
    input: z.object({ ...repo, playbook: relPath, inventory: z.string().min(1).optional() }),
    output: z.object({ ok: z.boolean(), output: z.string() }),
  },
  startRun: {
    experimental_description:
      "Launch a run detached on the control host under the status-writing supervisor and start tailing its stream.log. " +
      "Returns the supervisor's remote pid (the kill target). Lines arrive as `line` signals; `exit` follows once artifacts/<ident>/status exists.",
    input: z.object({ ...repo, ident, playbook: relPath, inventory: z.string().min(1).optional(), args: z.array(z.string()), env: envVars, mode: z.enum(RUN_MODES) }),
    output: z.object({ pid }),
  },
  attachRun: {
    experimental_description: "Re-open the tail of an existing run's stream.log from a 1-based line number; seq continues from fromLine. Pass the supervisor pid when known so a dead run is detected (else the run's pid file is used).",
    input: z.object({ ...repo, ident, fromLine: z.number().int().positive(), pid: pid.optional() }),
    output: z.object({ attached: z.boolean() }),
  },
  cancelRun: {
    experimental_description: "kill -INT the remote supervisor (kill -TERM when force). ok reflects the kill exit code.",
    input: z.object({ ...base, pid, force: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  runStatus: {
    experimental_description: "status and rc from artifacts/<ident>/ (null until written), the stream.log line count, and whether the supervisor is alive (null when no pid is known).",
    input: z.object({ ...repo, ident, pid: pid.optional() }),
    output: z.object({ status: z.string().nullable(), rc: z.number().int().nullable(), lines: z.number().int().nonnegative(), alive: z.boolean().nullable() }),
  },
  tailLog: {
    experimental_description: "The last `bytes` bytes of the run's stream.log.",
    input: z.object({ ...repo, ident, bytes: z.number().int().positive().max(1_048_576) }),
    output: z.object({ text: z.string() }),
  },
});

export type HostContract = typeof hostContract;

export const hostSignals = {
  /** One line of a run's stream.log; seq is the 1-based line number in that file and continuous within a tail. */
  line: { payload: z.object({ ident, seq: z.number().int().positive(), line: z.string() }) },
  /**
   * Something the tail process itself said on stderr (ssh warnings, "file has appeared", ...). It is
   * not part of stream.log, so it carries no seq of its own: afterSeq is the seq of the last line
   * delivered before it (0 when none yet). Consumers may show or drop it.
   */
  note: { payload: z.object({ ident, afterSeq: z.number().int().nonnegative(), text: z.string() }) },
  /**
   * The run ended. Normal end: code is the rc from artifacts/<ident>/rc, status the status word
   * (successful, failed, canceled, timeout), signal null. Otherwise code and status are null and
   * signal says why the host stopped following: "tail_lost" (the tail process died before status
   * existed; the run may still be going, reconcile with runStatus or attachRun), "lost" (status
   * never appeared and the supervisor pid is gone, e.g. python3 missing, SIGKILL, or a reboot),
   * "replaced" (a newer attachRun for the same ident took over this tail).
   */
  exit: { payload: z.object({ ident, code: z.number().int().nullable(), signal: z.string().nullable(), status: z.string().nullable() }) },
} as const satisfies ExperimentalHostSignals;

export type HostSignals = typeof hostSignals;
