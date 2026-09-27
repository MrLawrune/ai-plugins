import { createHash } from "node:crypto";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YNode, type Pair, type YAMLMap } from "yaml";
import type { PlaybookSummary, PlaySummary, TaskSummary, Warning } from "../../shared/types.ts";
import { plainLine } from "./verbs.ts";

export const PLAY_KEYWORDS = new Set(["name", "hosts", "become", "gather_facts", "serial", "strategy", "tags", "vars", "vars_files", "roles", "pre_tasks", "tasks", "post_tasks", "handlers", "become_user", "remote_user", "connection", "any_errors_fatal", "max_fail_percentage", "order", "environment", "vars_prompt", "collections", "module_defaults", "force_handlers", "ignore_unreachable", "no_log", "run_once", "throttle", "timeout", "check_mode", "diff", "debugger", "port"]);
export const TASK_KEYWORDS = new Set(["name", "when", "loop", "loop_control", "register", "notify", "tags", "become", "become_user", "delegate_to", "delegate_facts", "ignore_errors", "ignore_unreachable", "vars", "args", "changed_when", "failed_when", "until", "retries", "delay", "block", "rescue", "always", "listen", "run_once", "no_log", "environment", "connection", "remote_user", "any_errors_fatal", "throttle", "timeout", "check_mode", "diff", "module_defaults", "collections", "async", "poll", "local_action", "action"]);
const STR_MAX = 120;
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const str = (n: unknown): string => { if (n === undefined || n === null) return ""; const v = isScalar(n) ? n.value : (n as YNode | undefined)?.toJSON?.() ?? n; const s = typeof v === "string" ? v : (JSON.stringify(v) ?? ""); return s.length > STR_MAX ? s.slice(0, STR_MAX - 1) + "…" : s; };
const keyOf = (p: Pair): string => String(isScalar(p.key) ? p.key.value : p.key);
const get = (m: YAMLMap, k: string): YNode | undefined => m.get(k, true) as YNode | undefined;
const list = (n: YNode | undefined): string[] => n === undefined ? [] : isSeq(n) ? n.items.map((i) => str(i)) : [str(n)];
const bool = (n: YNode | undefined): boolean | null => (n === undefined ? null : Boolean((n as { toJSON(): unknown }).toJSON()));
const lineOf = (lc: LineCounter, n: YNode | null | undefined): number => n?.range ? lc.linePos(n.range[0]).line : 0;
const endLineOf = (lc: LineCounter, n: YNode | null | undefined): number => n?.range ? lc.linePos(Math.max(n.range[0], n.range[2] - 1)).line : 0;

function parseTask(m: YAMLMap, id: string, lc: LineCounter, warnings: Warning[]): TaskSummary {
  const line = lineOf(lc, m); const endLine = endLineOf(lc, m);
  const name = get(m, "name") === undefined ? null : str(get(m, "name"));
  const t: TaskSummary = { id, line, endLine, name, plain: "", action: "", args: [], when: null, loop: null, register: null, notify: [], tags: [], become: null, delegateTo: null, ignoreErrors: false };
  for (const p of m.items) {
    const k = keyOf(p); const v = p.value as YNode;
    if (k === "when") t.when = list(v).join(" and ");
    else if (k === "loop" || k.startsWith("with_")) { t.loop = str(v); if (k.startsWith("with_")) warnings.push({ line, message: `${k} is deprecated; use loop` }); }
    else if (k === "register") t.register = str(v);
    else if (k === "notify") t.notify = list(v);
    else if (k === "tags") t.tags = list(v);
    else if (k === "become") t.become = bool(v);
    else if (k === "delegate_to") t.delegateTo = str(v);
    else if (k === "ignore_errors") t.ignoreErrors = bool(v) === true;
    else if (k === "block" || k === "rescue" || k === "always") {
      t.action = "block"; t.children ??= { block: [], rescue: [], always: [] };
      if (isSeq(v)) t.children[k] = seqTasks(v, (i) => `${id}/t${i}`, lc, warnings);
    } else if (!TASK_KEYWORDS.has(k) && t.action === "") {
      t.action = k;
      if (isMap(v)) t.args = v.items.map((a) => ({ key: keyOf(a), value: str(a.value) }));
      else if (v !== undefined && v !== null) t.args = [{ key: "_raw", value: str(v) }];
      const inc = /^(?:[\w]+\.[\w]+\.)?(include|import)_(tasks|role|playbook)$/.exec(k);
      if (inc) t.include = { kind: inc[2] as "tasks" | "role" | "playbook", target: isMap(v) ? str(get(v, "name") ?? get(v, "file")) : str(v), static: inc[1] === "import" };
    }
  }
  if (t.action === "") { t.action = "unknown"; warnings.push({ line, message: "task has no module" }); }
  if (name === null && t.action !== "block") warnings.push({ line, message: "task has no name" });
  t.plain = plainLine(t.action, t.args, name, t.notify);
  return t;
}

// Non-mapping entries are skipped with a warning; ids keep the entry's index so they stay stable.
function seqTasks(n: YNode | undefined, idAt: (i: number) => string, lc: LineCounter, w: Warning[], startAt = 0): TaskSummary[] {
  if (!isSeq(n)) return [];
  const out: TaskSummary[] = [];
  n.items.forEach((t, i) => {
    if (!isMap(t)) { w.push({ line: lineOf(lc, t as YNode | null) || lineOf(lc, n), message: "task is not a mapping" }); return; }
    out.push(parseTask(t, idAt(startAt + i), lc, w));
  });
  return out;
}
const seqLen = (n: YNode | undefined): number => (isSeq(n) ? n.items.length : 0);

const taskList = (m: YAMLMap, key: string, playId: string, prefix: string, lc: LineCounter, w: Warning[]): TaskSummary[] =>
  seqTasks(get(m, key), (i) => `${playId}/${prefix}${i}`, lc, w);

export function parsePlaybook(env: string, path: string, content: string): PlaybookSummary {
  try { return parseUnsafe(env, path, content); } catch (e) {
    const base = emptySummary(env, path, content);
    return { ...base, error: { line: 1, message: e instanceof Error ? e.message : String(e) } };
  }
}

const emptySummary = (env: string, path: string, content: string): PlaybookSummary => ({ env, path, hash: sha256(content), name: path.replace(/^.*\//, "").replace(/\.ya?ml$/, ""), plays: [], imports: [], warnings: [], counts: { plays: 0, steps: 0, handlers: 0, roles: 0 }, targets: [] });

function parseUnsafe(env: string, path: string, content: string): PlaybookSummary {
  const hash = sha256(content);
  const base: PlaybookSummary = { env, path, hash, name: path.replace(/^.*\//, "").replace(/\.ya?ml$/, ""), plays: [], imports: [], warnings: [], counts: { plays: 0, steps: 0, handlers: 0, roles: 0 }, targets: [] };
  const lc = new LineCounter();
  const doc = parseDocument(content, { lineCounter: lc, keepSourceTokens: false });
  if (doc.errors.length) { const e = doc.errors[0]!; return { ...base, error: { line: e.linePos?.[0]?.line ?? lc.linePos(e.pos[0]).line, message: e.message.split("\n")[0]! } }; }
  const root = doc.contents;
  if (!isSeq(root)) return { ...base, error: { line: 1, message: "a playbook must be a list of plays" } };
  const warnings: Warning[] = [];
  const countSteps = (ts: TaskSummary[]): number => ts.reduce((n, t) => n + (t.children ? countSteps([...t.children.block, ...t.children.rescue, ...t.children.always]) : 1), 0);
  let pi = 0;
  for (const item of root.items as YNode[]) {
    if (!isMap(item)) { warnings.push({ line: lineOf(lc, item), message: "play is not a mapping" }); continue; }
    const imp = get(item, "import_playbook");
    if (imp !== undefined) { base.imports.push({ path: str(imp), line: lineOf(lc, item) }); continue; }
    const id = `p${pi++}`;
    const vars = get(item, "vars");
    const rolesNode = get(item, "roles");
    const roles = isSeq(rolesNode) ? rolesNode.items.map((r) => { const m = isMap(r) ? r : null; const name = m ? str(get(m, "role") ?? get(m, "name")) : str(r); return { id: `${id}/r${name}`, name, when: m && get(m, "when") !== undefined ? list(get(m, "when")).join(" and ") : null, tags: m ? list(get(m, "tags")) : [] }; }) : [];
    for (const p of item.items) if (!PLAY_KEYWORDS.has(keyOf(p))) warnings.push({ line: lineOf(lc, item), message: `unknown play key ${keyOf(p)}` });
    const play: PlaySummary = {
      id, name: get(item, "name") === undefined ? `play ${pi}` : str(get(item, "name")), line: lineOf(lc, item), endLine: endLineOf(lc, item),
      hosts: str(get(item, "hosts") ?? "all"), become: bool(get(item, "become")), gatherFacts: bool(get(item, "gather_facts")),
      serial: get(item, "serial") === undefined ? null : str(get(item, "serial")), strategy: get(item, "strategy") === undefined ? null : str(get(item, "strategy")),
      tags: list(get(item, "tags")), vars: { keys: isMap(vars) ? vars.items.map(keyOf) : [], files: list(get(item, "vars_files")) }, roles,
      preTasks: taskList(item, "pre_tasks", id, "t", lc, warnings), tasks: [], postTasks: [], handlers: [],
    };
    // task ids continue across pre_tasks → tasks → post_tasks so "p0/t3" is unique within the play
    const offset = seqLen(get(item, "pre_tasks"));
    const tasksNode = get(item, "tasks"); const postNode = get(item, "post_tasks");
    play.tasks = seqTasks(tasksNode, (i) => `${id}/t${i}`, lc, warnings, offset);
    play.postTasks = seqTasks(postNode, (i) => `${id}/t${i}`, lc, warnings, offset + seqLen(tasksNode));
    play.handlers = taskList(item, "handlers", id, "h", lc, warnings);
    base.plays.push(play);
    base.counts.steps += countSteps([...play.preTasks, ...play.tasks, ...play.postTasks]);
    base.counts.handlers += play.handlers.length; base.counts.roles += roles.length;
    if (!base.targets.includes(play.hosts)) base.targets.push(play.hosts);
  }
  base.counts.plays = base.plays.length;
  if (base.plays[0]) base.name = base.plays[0].name;
  base.warnings = warnings;
  return base;
}
