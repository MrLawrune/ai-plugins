// `bb playbooks …` — the command set agents and humans use. Reads go through the services; the only writes are
// starting and cancelling runs. Runs started from a thread confirm through a form the human answers.
import { cliCommand, defineCli, PluginCliError, type PluginCliContext } from "@get-bb/plugin-sdk";
import type { HostClient, RunService } from "./runs.ts";
import type { DispatchLike } from "./rpc.ts";
import { readSlice } from "./rpc.ts";
import type { EnvService } from "./envs.ts";
import type { LibraryService } from "./library.ts";
import type { CredRefRow, PlaybooksEnvRow, RunEventRow, RunRow, Store } from "./store.ts";
import { renderContext, type ContextFailure, type ContextInput } from "./context.ts";
import { formatTarget, parseRunRef, parseTarget, type Target } from "./targets.ts";
import { BUDGETS } from "../shared/constants.ts";
import type { EnvBadgeDto, PlaybookSummary, RunSpec, RunStatus, RunView, TaskSummary } from "../shared/types.ts";

/** What the run form (Task 21) is rendered from; at most 64 KiB serialized. */
export interface RunFormPayload {
  env: EnvBadgeDto;
  playbook: string;
  summaryLine: string;
  spec: RunSpec;
  policy: { applyAllowed: boolean; applyNeedsTyped: boolean; phrase: string | null };
  inventories: string[];
  credRefs: { id: string; name: string }[];
}
export type RunFormValue = RunSpec & { typed?: string };
export type RunFormResult = { outcome: "submitted"; value: RunFormValue } | { outcome: "cancelled"; reason: string };

export interface CliDeps {
  envs: EnvService;
  library: LibraryService;
  runs: RunService;
  store: Pick<Store, "getRun" | "getEnv" | "listRuns" | "listEvents" | "listCredRefs">;
  host: HostClient;
  hostIdFor(env: PlaybooksEnvRow): string;
  dispatch: DispatchLike | null;
  requestRunForm(threadId: string, payload: RunFormPayload, signal: AbortSignal): Promise<RunFormResult>;
  /** Timer seam for `run --wait`; defaults to setTimeout. */
  sleep?(ms: number): Promise<void>;
  /** Reads a slice of a run's local stream log; defaults to the filesystem. */
  readLog?(path: string, offset: number, bytes: number): Promise<{ text: string; size: number }>;
}

const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
const ok = (stdout: string) => ({ exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : stdout + "\n" });
const asJson = (v: Record<string, unknown>) => ok(JSON.stringify({ ok: true, ...v }, null, 2));
const TARGET_HINT = "targets: <env> · <env>/<path> · <env>/<path>#<node>; runs: run_<id>. See `bb playbooks envs`.";
const notFound = (target: string) => new PluginCliError(`unknown target ${target}`, { code: "not_found", hint: TARGET_HINT });

const PAGE_BYTES = 64 * 1024;
const JSON_PAGE_BYTES = 512 * 1024;
const FORM_MAX_BYTES = 64 * 1024;
const WAIT_LINES = 100;
const POLL_MS = 1000;
const TERMINAL: ReadonlySet<RunStatus> = new Set(["success", "failed", "canceled", "unknown"]);
const GLYPH: Record<RunStatus, string> = { queued: "·", starting: "◐", running: "◐", success: "✓", failed: "✗", canceled: "–", unknown: "?" };

const oneLine = (s: string | null | undefined, max = 200): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function flatten(tasks: TaskSummary[], depth: number, out: string[]): void {
  for (const t of tasks) {
    out.push(`${"  ".repeat(depth)}${t.id} ${t.plain}`);
    if (t.children) flatten([...t.children.block, ...t.children.rescue, ...t.children.always], depth + 1, out);
  }
}

/** The L1 plain-language text of a playbook. */
function summaryText(s: PlaybookSummary): string {
  const lines = [`${s.name} — ${s.env}/${s.path}`];
  if (s.error) return [...lines, `parse error (line ${s.error.line}): ${s.error.message}`].join("\n");
  lines.push(`${s.counts.plays} plays · ${s.counts.steps} steps · ${s.counts.handlers} handlers · ${s.counts.roles} roles`);
  for (const w of s.warnings) lines.push(`warning line ${w.line}: ${w.message}`);
  for (const p of s.plays) {
    lines.push(`${p.id} ${p.name || "(unnamed play)"} (hosts: ${p.hosts})`);
    for (const r of p.roles) lines.push(`  ${r.id} role ${r.name}`);
    flatten([...p.preTasks, ...p.tasks, ...p.postTasks], 1, lines);
    flatten(p.handlers, 1, lines);
  }
  return lines.join("\n");
}

const recapLines = (v: RunView): string[] => {
  const head = `${GLYPH[v.status]} ${v.status}  ${v.runId} ${v.env.slug} ${v.playbook}`;
  const hosts = Object.entries(v.recap ?? {}).map(([h, s]) => `  ${h}: ok=${s.ok} changed=${s.changed} unreachable=${s.unreachable} failed=${s.failures} skipped=${s.skipped} rescued=${s.rescued} ignored=${s.ignored}`);
  return [head, ...hosts];
};

const eventLine = (e: RunEventRow, detail: boolean): string => {
  const head = `#${e.seq} ${new Date(e.at).toISOString().slice(11, 19)} ${e.kind} ${e.host ?? "-"} ${oneLine(e.task, 80) || e.nodeId || "-"}${e.msg ? ` ${oneLine(e.msg)}` : ""}`;
  if (!detail) return head;
  const parts = [e.res && `res: ${e.res}`, e.diff && `diff: ${e.diff}`, e.stdout && `stdout: ${e.stdout}`].filter((x): x is string => !!x);
  return parts.length ? `${head}\n${parts.join("\n")}` : head;
};

function parseExtraVars(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) throw new PluginCliError(`bad -e value "${p}"`, { code: "invalid_value", hint: "use -e key=value" });
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

export function createCli(d: CliDeps) {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env = (slug: string, target = slug): PlaybooksEnvRow => d.envs.get(slug) ?? (() => { throw notFound(target); })();
  const fileTarget = (raw: string): Target & { path: string } => {
    const t = parseTarget(raw);
    if (!t || !t.path) throw new PluginCliError(`expected <env>/<path>, got ${raw}`, { code: "not_found", hint: TARGET_HINT });
    return { ...t, path: t.path };
  };
  const summaryOf = async (t: Target & { path: string }, raw: string, threadId?: string) => {
    env(t.env, raw);
    const res = await d.library.summary(t.env, t.path, threadId ? { threadId } : {});
    if ("notFound" in res) throw notFound(raw);
    if ("unreachable" in res) throw new PluginCliError(res.unreachable, { code: "unreachable", hint: `check the control host with \`bb playbooks envs\`` });
    return res;
  };
  const runOrThrow = (runId: string): RunRow => d.store.getRun(runId) ?? (() => { throw new PluginCliError(`unknown run ${runId}`, { code: "not_found", hint: "list runs with `bb playbooks runs`" }); })();

  const waitFor = async (runId: string, ctx: PluginCliContext): Promise<string[]> => {
    const lines: string[] = [];
    const seen = new Set<string>();
    const emit = (key: string, line: string): void => {
      if (seen.has(key)) return;
      seen.add(key);
      if (lines.length < WAIT_LINES) lines.push(line);
      else if (lines.length === WAIT_LINES) lines.push("… further progress suppressed; see `bb playbooks log`");
    };
    for (;;) {
      const v = await d.runs.view(runId);
      if (!v) throw new PluginCliError(`unknown run ${runId}`, { code: "not_found" });
      for (const p of v.plays) {
        if (p.tasks.some((t) => Object.values(t.cells).some((c) => c !== "pending"))) emit(`play:${p.id}`, `play ${p.id} ${p.name}`);
        for (const t of p.tasks) for (const [h, c] of Object.entries(t.cells)) {
          if (c === "failed" || c === "unreachable") emit(`fail:${h}:${t.nodeId ?? t.name}`, `${h} ${c === "failed" ? "✗" : "!"} ${t.name}`);
        }
      }
      if (TERMINAL.has(v.status)) return [...lines, ...recapLines(v)];
      if (ctx.signal?.aborted) return [...lines, `stopped waiting; ${runId} is still ${v.status}`];
      await sleep(POLL_MS);
    }
  };

  const formPayload = async (e: PlaybooksEnvRow, playbook: string, spec: RunSpec, summaryLine: string, phrase: string | null): Promise<RunFormPayload> => {
    const inventories = await d.library.discoverInventories(e.slug).then((r) => r.map((i) => i.path)).catch(() => []);
    const base: RunFormPayload = {
      env: d.envs.badge(e), playbook, summaryLine, spec,
      policy: { applyAllowed: e.kind !== "prod", applyNeedsTyped: e.kind === "prod", phrase },
      inventories, credRefs: d.store.listCredRefs(e.id).map((c: CredRefRow) => ({ id: c.id, name: c.name })),
    };
    if (Buffer.byteLength(JSON.stringify(base)) <= FORM_MAX_BYTES) return base;
    return { ...base, inventories: [], credRefs: [] };
  };

  return defineCli({
    name: "playbooks",
    summary: "Ansible playbooks: environments, plain-language summaries, and live runs",
    description: "Targets: <env>, <env>/<path>, <env>/<path>#<node> (p0, p0/t1, p0/rname, p0/h0); runs are run_<id>. The plugin never edits playbook files; edit them on the control host.",
    commands: {
      envs: cliCommand({
        summary: "One line per environment: kind, control host, repository, health",
        options: { json },
        run: ({ options }) => {
          const rows = d.envs.list().map((e) => ({ env: d.envs.badge(e), controlHost: e.controlHost, repoPath: e.repoPath, enabled: e.enabled, health: d.envs.health(e.id) }));
          if (options.json) return asJson({ envs: rows });
          return ok(rows.length ? rows.map((r) => `${r.env.slug} (${r.env.kind}) · ${r.controlHost}:${r.repoPath} · ${!r.enabled ? "disabled" : r.health?.code ?? "untested"}`).join("\n") : "(no environments; add one in Settings → Plugins → Playbooks)");
        },
      }),
      rules: cliCommand({
        summary: "The environment's rules (conventions agents must follow there)",
        positionals: [{ name: "env", description: "Environment slug", required: true }],
        options: { json },
        run: ({ positionals, options }) => {
          const e = env(positionals.env);
          return options.json ? asJson({ env: e.slug, rules: e.rules }) : ok(e.rules.trim() || "(no rules)");
        },
      }),
      context: cliCommand({
        summary: "A compact context block for an environment, playbook, play, task, or run cell",
        positionals: [{ name: "target", description: "<env>[/<path>[#<node>]] or run_<id>[/<host>/<node>]", required: true }],
        options: {
          run: { type: "string", description: "Include this run's state (playbook targets)" },
          budget: { type: "integer", min: 10, max: 65536, default: BUDGETS.addToChat, description: "Maximum output size in bytes (10-65536)" },
          json,
        },
        run: async ({ positionals, options }, ctx) => {
          const raw = positionals.target;
          const runRef = raw.startsWith("run_") ? parseRunRef(raw) : null;
          const t = runRef ? null : parseTarget(raw);
          if (!runRef && !t) throw notFound(raw);
          let input: ContextInput;
          if (runRef) {
            const row = runOrThrow(runRef.runId);
            const e = d.store.getEnv(row.envId);
            if (!e) throw notFound(raw);
            const run = await d.runs.view(runRef.runId);
            const res = await d.library.summary(e.slug, row.playbook);
            let failure: ContextFailure | undefined;
            if (runRef.host && runRef.node) {
              const f = d.store.listEvents(row.id, { cursor: 0, limit: 10_000, host: runRef.host, node: runRef.node, failedOnly: true }).pop();
              if (f) failure = { host: runRef.host, nodeId: runRef.node, msg: f.msg ?? "", res: f.res ?? "", stdout: f.stdout ?? "", diff: f.diff };
            }
            input = { target: runRef, env: e, head: d.envs.health(e.id)?.head ?? null, summary: "summary" in res ? res.summary : null, content: "summary" in res ? res.content : null, run, ...(failure ? { failure } : {}), budget: options.budget };
          } else {
            const e = env(t!.env, raw);
            const res = t!.path ? await d.library.summary(e.slug, t!.path, ctx.threadId ? { threadId: ctx.threadId } : {}) : null;
            if (res && "notFound" in res) throw notFound(raw);
            if (res && "unreachable" in res) throw new PluginCliError(res.unreachable, { code: "unreachable" });
            const run = options.run ? await d.runs.view(options.run) : null;
            input = { target: t!, env: e, head: d.envs.health(e.id)?.head ?? null, summary: res?.summary ?? null, content: res?.content ?? null, run, budget: options.budget };
          }
          const text = renderContext(input);
          return options.json ? asJson({ target: raw, context: text }) : ok(text);
        },
      }),
      show: cliCommand({
        summary: "Plain-language summary of a playbook; ends with the ::playbook line to paste in your reply",
        positionals: [{ name: "target", description: "<env>/<path>", required: true }],
        options: { json },
        run: async ({ positionals, options }, ctx) => {
          const t = fileTarget(positionals.target);
          const { summary } = await summaryOf(t, positionals.target, ctx.threadId);
          if (options.json) return asJson({ summary });
          return ok(`${summaryText(summary)}\n::playbook{env="${t.env}" file="${t.path}"}`);
        },
      }),
      check: cliCommand({
        summary: "Parse warnings, ansible syntax check, and task list, run on the control host",
        positionals: [{ name: "target", description: "<env>/<path>", required: true }],
        options: { inventory: { type: "string", description: "Inventory path for the check" }, json },
        run: async ({ positionals, options }, ctx) => {
          const t = fileTarget(positionals.target);
          const { summary } = await summaryOf(t, positionals.target, ctx.threadId);
          const e = env(t.env);
          const call = { controlHost: e.controlHost, repoPath: e.repoPath, playbook: t.path, ...(options.inventory ? { inventory: options.inventory } : {}) };
          const opts = { hostId: d.hostIdFor(e) };
          const [syntax, tasks] = await Promise.all([d.host.call("syntaxCheck", call, opts), d.host.call("listTasks", call, opts)]).catch((err) => {
            throw new PluginCliError(err instanceof Error ? err.message : String(err), { code: "unreachable", hint: "check the control host with `bb playbooks envs`" });
          });
          if (options.json) return { ...asJson({ warnings: summary.warnings, syntax, tasks }), exitCode: syntax.ok ? 0 : 1 };
          const lines = [...summary.warnings.map((w) => `warning line ${w.line}: ${w.message}`), `syntax: ${syntax.ok ? "ok" : "FAILED"}`];
          if (!syntax.ok) lines.push(syntax.output.trim());
          lines.push("tasks:", tasks.output.trim());
          return { exitCode: syntax.ok ? 0 : 1, stdout: lines.join("\n") + "\n" };
        },
      }),
      library: cliCommand({
        summary: "Playbooks in an environment with step counts and last run",
        positionals: [{ name: "env", description: "Environment slug", required: true }],
        options: { json },
        run: async ({ positionals, options }) => {
          env(positionals.env);
          const entries = await d.library.list(positionals.env);
          if (options.json) return asJson({ entries });
          return ok(entries.length ? entries.map((x) => `${x.path} · ${x.name} · ${x.counts.plays} plays ${x.counts.steps} steps · ${x.lastRun ? `${x.lastRun.status} ${x.lastRun.id}` : "never run"}`).join("\n") : "(no playbooks)");
        },
      }),
      inventories: cliCommand({
        summary: "Inventories in an environment; --resolve lists one inventory's groups and hosts",
        positionals: [{ name: "env", description: "Environment slug", required: true }],
        options: { resolve: { type: "string", description: "Inventory path to resolve with ansible-inventory" }, json },
        run: async ({ positionals, options }) => {
          env(positionals.env);
          if (options.resolve) {
            const r = await d.library.resolveInventory(positionals.env, options.resolve);
            if (!r) throw notFound(positionals.env);
            return options.json ? asJson({ ...r }) : ok(`groups: ${r.groups.join(", ") || "(none)"}\nhosts: ${r.hosts.join(", ") || "(none)"}`);
          }
          const rows = await d.library.discoverInventories(positionals.env);
          return options.json ? asJson({ inventories: rows }) : ok(rows.length ? rows.map((i) => `${i.path} (${i.kind})${i.groups ? ` groups: ${JSON.parse(i.groups).join(", ")}` : ""}`).join("\n") : "(no inventories)");
        },
      }),
      creds: cliCommand({
        summary: "Credential references for an environment (names and non-secret settings only)",
        positionals: [{ name: "env", description: "Environment slug", required: true }],
        options: { json },
        run: ({ positionals, options }) => {
          const refs = d.store.listCredRefs(env(positionals.env).id);
          if (options.json) return asJson({ credRefs: refs.map((c) => ({ id: c.id, name: c.name, sshUser: c.sshUser, becomeMethod: c.becomeMethod, vault: c.vaultPasswordFile !== null })) });
          return ok(refs.length ? refs.map((c) => `${c.name} · user ${c.sshUser ?? "-"} · become ${c.becomeMethod ?? "-"} · vault ${c.vaultPasswordFile ? "yes" : "no"}`).join("\n") : "(no credential references)");
        },
      }),
      run: cliCommand({
        summary: "Start a run; in a thread the human confirms in a form. Check mode is the default",
        positionals: [{ name: "target", description: "<env>/<path>", required: true }],
        options: {
          inventory: { type: "string", description: "Inventory path (default: ansible's own)" },
          limit: { type: "string", description: "Host pattern for --limit" },
          tags: { type: "string", repeatable: true, split: ",", description: "Only these tags (comma-separated)" },
          "skip-tags": { type: "string", repeatable: true, split: ",", description: "Skip these tags" },
          e: { type: "string", short: "e", repeatable: true, description: "Extra var key=value (repeatable)" },
          cred: { type: "string", description: "Credential reference name (see `bb playbooks creds`)" },
          check: { type: "boolean", description: "Check mode (the default)" },
          apply: { type: "boolean", description: "Apply changes (not check mode)" },
          diff: { type: "boolean", description: "Show diffs" },
          template: { type: "string", description: "Run template (not available yet)" },
          wait: { type: "boolean", description: "Wait for the run and print progress and the recap" },
          "no-confirm": { type: "boolean", description: "Run without a form (only where policy allows; needed outside a thread)" },
          json,
        },
        constraints: [{ kind: "at-most-one", options: ["check", "apply"] }],
        run: async ({ positionals, options }, ctx) => {
          if (options.template) throw new PluginCliError("templates arrive in a later version", { code: "not_supported" });
          const t = fileTarget(positionals.target);
          const e = env(t.env, positionals.target);
          let credRefId: string | null = null;
          if (options.cred) {
            const c = d.store.listCredRefs(e.id).find((x) => x.name === options.cred);
            if (!c) throw new PluginCliError(`unknown credential reference ${options.cred}`, { code: "not_found", hint: `see \`bb playbooks creds ${e.slug}\`` });
            credRefId = c.id;
          }
          const spec: RunSpec = {
            inventory: options.inventory ?? "", limit: options.limit ?? "", tags: options.tags ?? [], skipTags: options["skip-tags"] ?? [],
            extraVars: parseExtraVars(options.e ?? []), credRefId, check: !options.apply, diff: options.diff ?? false, verbosity: 0, branch: null,
          };
          const source = { surface: "cli" as const, threadId: ctx.threadId ?? null };
          const headless = !ctx.threadId && !options["no-confirm"];
          const needsHuman = new PluginCliError("a human must confirm this run and there is no thread to ask in", { code: "confirmation_required", hint: "run it from a thread, or pass --no-confirm to run headless where policy allows" });
          if (headless) throw needsHuman;
          const prepared = await d.runs.prepare({ envId: e.id, playbook: t.path, spec, source, noConfirm: options["no-confirm"] });
          if (!prepared.allowed) throw new PluginCliError(prepared.reason, { code: "run_refused" });
          let final = spec;
          let approval: string = prepared.confirm;
          let typed: string | undefined;
          if (prepared.confirm !== "none") {
            if (!ctx.threadId) throw needsHuman;
            const payload = await formPayload(e, t.path, spec, prepared.summaryLine, prepared.phrase);
            const form = await d.requestRunForm(ctx.threadId, payload, ctx.signal ?? new AbortController().signal);
            if (form.outcome === "cancelled") throw new PluginCliError(`run cancelled (${form.reason})`, { code: "run_cancelled", exitCode: 2 });
            const { typed: t2, ...value } = form.value;
            final = value;
            typed = t2;
            approval = "interaction";
            if (JSON.stringify(final) !== JSON.stringify(spec)) {
              const again = await d.runs.prepare({ envId: e.id, playbook: t.path, spec: final, source, noConfirm: false });
              if (!again.allowed) throw new PluginCliError(again.reason, { code: "run_refused" });
            }
          }
          let row: RunRow;
          try {
            row = await d.runs.start({ envId: e.id, playbook: t.path, spec: final, source: { ...source, scheduleId: null }, approval, typed });
          } catch (err) {
            throw new PluginCliError(err instanceof Error ? err.message : String(err), { code: "run_start_failed", hint: "check the control host with `bb playbooks envs`" });
          }
          const head = `started ${row.id} · ${prepared.summaryLine}`;
          const lines = options.wait ? await waitFor(row.id, ctx) : [`follow: bb playbooks status ${row.id}`];
          if (options.json) return asJson({ runId: row.id, summaryLine: prepared.summaryLine, ...(options.wait ? { progress: lines } : {}) });
          return ok([head, ...lines].join("\n"));
        },
      }),
      status: cliCommand({
        summary: "One-line status of a run, its counters, and its investigations",
        positionals: [{ name: "runId", description: "run_<id>", required: true }],
        options: { json },
        run: async ({ positionals, options }) => {
          const v = await d.runs.view(positionals.runId);
          if (!v) throw new PluginCliError(`unknown run ${positionals.runId}`, { code: "not_found", hint: "list runs with `bb playbooks runs`" });
          if (options.json) return asJson({ view: v });
          const c = v.counters;
          const lines = [`${GLYPH[v.status]} ${v.status}  ${v.env.slug} ${v.playbook} · ${v.hosts.length} hosts · ok ${c.ok} changed ${c.changed} failed ${c.failed} unreachable ${c.unreachable} skipped ${c.skipped}`];
          for (const i of v.investigations) lines.push(`investigation ${i.threadId}${i.host ? ` ${i.host}` : ""}${i.nodeId ? ` ${i.nodeId}` : ""}${i.permissionMode ? ` (${i.permissionMode})` : ""} · ${i.status}${i.summary ? `: ${oneLine(i.summary)}` : ""}`);
          return ok(lines.join("\n"));
        },
      }),
      log: cliCommand({
        summary: "A run's events, paged; --raw reads the raw stream in 64 KiB pages",
        positionals: [{ name: "runId", description: "run_<id>", required: true }],
        options: {
          failed: { type: "boolean", description: "Only failures" },
          host: { type: "string", description: "Only this host" },
          node: { type: "string", description: "Only this node id (e.g. p0/t1)" },
          cursor: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, default: 0, description: "Continue after this event seq (byte offset with --raw)" },
          limit: { type: "integer", min: 1, max: 200, default: 50, description: "Maximum events (1-200)" },
          raw: { type: "boolean", description: "Read the raw stream log instead of events" },
          json,
        },
        run: async ({ positionals, options }) => {
          const run = runOrThrow(positionals.runId);
          if (options.raw) {
            if (!run.logPath) return options.json ? asJson({ text: "", nextCursor: null }) : ok("(no raw log)");
            const { text, size } = await (d.readLog ?? readSlice)(run.logPath, options.cursor, PAGE_BYTES);
            const next = options.cursor + Math.min(PAGE_BYTES, Math.max(0, size - options.cursor));
            const nextCursor = next < size ? next : null;
            return options.json ? asJson({ text, nextCursor }) : ok(`${text.replace(/\n$/, "")}${nextCursor !== null ? `\nnextCursor: ${nextCursor}` : ""}`);
          }
          const events = d.store.listEvents(run.id, {
            cursor: options.cursor, limit: options.limit,
            ...(options.host ? { host: options.host } : {}), ...(options.node ? { node: options.node } : {}), ...(options.failed ? { failedOnly: true } : {}),
          });
          if (options.json) {
            let bytes = 0;
            const kept: RunEventRow[] = [];
            for (const e of events) {
              bytes += Buffer.byteLength(JSON.stringify(e));
              if (bytes > JSON_PAGE_BYTES && kept.length > 0) break;
              kept.push(e);
            }
            const dropped = events[kept.length];
            const next = dropped ? dropped.seq - 1 : events.length === options.limit ? events[events.length - 1]!.seq : null;
            return asJson({ events: kept, nextCursor: next });
          }
          // Text pages are byte-bounded too: detail mode prints res/diff/stdout, which can be tens of KB per event.
          const detail = !!options.host && !!options.node;
          let bytes = 0;
          const lines: string[] = [];
          let dropped: RunEventRow | undefined;
          for (const e of events) {
            const l = eventLine(e, detail);
            bytes += Buffer.byteLength(l) + 1;
            if (bytes > JSON_PAGE_BYTES && lines.length > 0) { dropped = e; break; }
            lines.push(l);
          }
          const nextCursor = dropped ? dropped.seq - 1 : events.length === options.limit ? events[events.length - 1]!.seq : null;
          if (nextCursor !== null) lines.push(`nextCursor: ${nextCursor}`);
          return ok(lines.length ? lines.join("\n") : "(no events)");
        },
      }),
      cancel: cliCommand({
        summary: "Stop a running run (SIGINT; --force sends SIGTERM)",
        positionals: [{ name: "runId", description: "run_<id>", required: true }],
        options: { force: { type: "boolean", description: "SIGTERM instead of SIGINT" }, json },
        run: async ({ positionals, options }) => {
          runOrThrow(positionals.runId);
          try {
            const r = await d.runs.cancel(positionals.runId, options.force);
            return options.json ? asJson({ ...r }) : ok(r.ok ? `cancel requested for ${positionals.runId}` : `could not cancel ${positionals.runId}`);
          } catch (err) {
            throw new PluginCliError(err instanceof Error ? err.message : String(err), { code: "cancel_failed" });
          }
        },
      }),
      runs: cliCommand({
        summary: "Recent runs, newest first",
        options: {
          env: { type: "string", description: "Only this environment" },
          file: { type: "string", description: "Only this playbook path" },
          limit: { type: "integer", min: 1, max: 200, default: 20, description: "Maximum rows (1-200)" },
          json,
        },
        run: ({ options }) => {
          const e = options.env ? env(options.env) : null;
          const rows = d.store.listRuns({ ...(e ? { envId: e.id } : {}), ...(options.file ? { playbook: options.file } : {}), limit: options.limit });
          if (options.json) return asJson({ runs: rows.map((r) => ({ id: r.id, env: d.store.getEnv(r.envId)?.slug ?? null, playbook: r.playbook, status: r.status, requestedAt: r.requestedAt, check: r.spec.check })) });
          return ok(rows.length ? rows.map((r) => `${r.id} ${GLYPH[r.status]} ${r.status} ${d.store.getEnv(r.envId)?.slug ?? "?"}/${r.playbook} (${r.spec.check ? "check" : "apply"})`).join("\n") : "(no runs)");
        },
      }),
      investigate: cliCommand({
        summary: "Open a read-only debug thread for a failed run",
        positionals: [{ name: "runId", description: "run_<id>", required: true }],
        options: { host: { type: "string", description: "Failing host" }, node: { type: "string", description: "Failing node id (e.g. p0/t1)" }, json },
        run: async ({ positionals, options }, ctx) => {
          if (!d.dispatch) throw new PluginCliError("investigations are not available yet", { code: "not_supported" });
          runOrThrow(positionals.runId);
          const r = await d.dispatch.investigate({ runId: positionals.runId, host: options.host, node: options.node, threadId: ctx.threadId, projectId: ctx.projectId });
          const mode = r.permissionMode === "readonly" ? "read-only" : `${r.permissionMode}: approvals required`;
          return options.json ? asJson({ threadId: r.threadId, permissionMode: r.permissionMode }) : ok(`opened debug thread ${r.threadId} (${mode})`);
        },
      }),
    },
  });
}
