// Renders the budgeted context block an agent receives when the user adds a step, playbook, or failure to a
// chat (spec §6.7). Sections are whole units: when over budget they are dropped from the bottom, never cut
// mid-line; the header and the footer always stay.
import { BUDGETS } from "../shared/constants.ts";
import type { PlaySummary, PlaybookSummary, RunView, TaskSummary } from "../shared/types.ts";
import { excerpt } from "./parser/excerpt.ts";
import type { PlaybooksEnvRow } from "./store.ts";
import { formatTarget, type Target } from "./targets.ts";

export type ContextTarget = Target | { runId: string; host?: string; node?: string };
export interface ContextFailure { host: string; nodeId: string; msg: string; res: string; stdout: string; diff: string | null }
export interface ContextInput {
  target: ContextTarget; env: PlaybooksEnvRow; head: string | null; summary: PlaybookSummary | null; content: string | null;
  run: RunView | null; cellMessages?: Record<string, string> | undefined;
  /** One failure block per entry (investigations: every failed cell in scope). `failure` is the single-cell shorthand. */
  failure?: ContextFailure | undefined; failures?: ContextFailure[] | undefined; instruction?: string | undefined; budget: number;
}

const bytes = (s: string): number => Buffer.byteLength(s);

/** Keep the first (or, with `tail`, the last) `max` bytes without splitting a character. */
function clip(s: string, max: number, tail = false): string {
  if (bytes(s) <= max) return s;
  const b = Buffer.from(s);
  const cut = (tail ? b.subarray(b.length - max) : b.subarray(0, max)).toString();
  return tail ? cut.replace(/^�+/, "") : cut.replace(/�+$/, "");
}

/** `clip` with a trailing ellipsis when something was cut. */
const clipMarked = (s: string, max: number): string => (bytes(s) <= max ? s : `${clip(s, max - 1)}…`);

const flatten = (tasks: TaskSummary[]): TaskSummary[] =>
  tasks.flatMap((t) => [t, ...(t.children ? flatten([...t.children.block, ...t.children.rescue, ...t.children.always]) : [])]);

type Node = { play: PlaySummary; line: number; endLine: number; step: string | null };

function findNode(summary: PlaybookSummary, id: string): Node | null {
  const play = summary.plays.find((p) => id === p.id || id.startsWith(`${p.id}/`));
  if (!play) return null;
  if (id === play.id) return { play, line: play.line, endLine: play.endLine, step: null };
  const pos = (id.split("/").pop() ?? "").slice(1);
  const role = play.roles.find((r) => r.id === id);
  if (role) return { play, line: play.line, endLine: play.endLine, step: `role "${role.name}"` };
  const handler = play.handlers.find((h) => h.id === id);
  const task = handler ?? flatten([...play.preTasks, ...play.tasks, ...play.postTasks]).find((t) => t.id === id);
  if (!task) return { play, line: play.line, endLine: play.endLine, step: null };
  const parts = [`${handler ? "handler " : ""}${Number(pos) + 1} "${task.name ?? task.plain}"`, task.action];
  if (task.when) parts.push(`when: ${task.when}`);
  if (task.notify.length) parts.push(`notify: ${task.notify.join(", ")}`);
  return { play, line: task.line, endLine: task.endLine, step: `step: ${parts.join(" · ")}` };
}

function lastRunLine(run: RunView, nodeId: string | undefined, messages: Record<string, string>): string {
  const head = `last run: ${run.runId} ${run.status}`;
  const task = nodeId ? run.plays.flatMap((p) => p.tasks).find((t) => t.nodeId === nodeId) : undefined;
  const cells = task ? Object.entries(task.cells).map(([h, c]) => `${h} ${c}`).join(", ") : "";
  const failed = task ? Object.entries(task.cells).filter(([h, c]) => c === "failed" && messages[h]).map(([h]) => `${h} ✗ "${messages[h]}"`) : [];
  return [head, cells, ...failed].filter(Boolean).join(" · ");
}

export function renderContext(input: ContextInput): string {
  const { target, env, head, summary, content, run } = input;
  const failures = input.failures ?? (input.failure ? [input.failure] : []);
  const investigate = "runId" in target;
  const nodeId = target.node;
  const node = summary && nodeId ? findNode(summary, nodeId) : null;

  const header = investigate
    ? `## Playbooks context — ${target.runId}${target.host || nodeId ? ` (${[target.host, nodeId].filter(Boolean).join(", ")})` : ""}`
    : `## Playbooks context — ${formatTarget(target)}`;
  const footer = investigate
    ? `diagnose only: read files and run read-only commands on ${env.controlHost}; propose a fix as a diff or numbered steps; do not run playbooks; when done, summarise the cause in one line first.`
    : "how to: to run or check this playbook, paste the ::playbook line";

  // Tagged so the budget loop can report dropped failure blocks; the instruction lives outside the loop.
  const sections: { lines: string[]; failure?: true }[] = [];
  const push = (lines: string[]): void => { sections.push({ lines }); };
  push([`env: ${env.slug} (${env.kind}) · control host: ${env.controlHost} · repo: ${env.repoPath}${head ? ` @ ${head}` : ""}`]);
  const rules = env.rules.replace(/\s+/g, " ").trim();
  if (rules) push([`rules: ${rules.length > BUDGETS.rules ? `${rules.slice(0, BUDGETS.rules).trimEnd()}…` : rules} (see \`bb playbooks rules ${env.slug}\`)`]);
  if (summary) push([`file: ${summary.path} · ${summary.name}${node ? ` · play ${node.play.id} "${node.play.name}" (hosts: ${node.play.hosts})` : ""}`]);
  if (node?.step) push([node.step]);
  if (node && content) push(excerpt(content, node.line, node.endLine, BUDGETS.excerpt).split("\n"));
  if (node && node.play.vars.keys.length) push([`play vars: ${node.play.vars.keys.join(", ")}`]);
  if (run) push([lastRunLine(run, nodeId, { ...Object.fromEntries(failures.map((f) => [f.host, f.msg])), ...input.cellMessages })]);
  if (investigate) {
    for (const failure of failures) {
      const block = [`failed host: ${failure.host}`, `node: ${failure.nodeId}`, `message: ${failure.msg}`, `result: ${clip(failure.res, BUDGETS.res)}`];
      if (failure.stdout) block.push("output tail:", ...clip(failure.stdout, BUDGETS.errorTail, true).split("\n"));
      if (failure.diff) block.push("diff:", ...clip(failure.diff, BUDGETS.res).split("\n"));
      sections.push({ lines: block, failure: true });
    }
  }
  const instruction = input.instruction ? [`instruction: ${clipMarked(input.instruction, BUDGETS.instruction)}`] : null;

  let omitted = 0;
  const render = (): string => {
    const body = sections.map((s) => s.lines);
    if (omitted) body.push([`… ${omitted} more failure${omitted === 1 ? "" : "s"} omitted`]);
    if (instruction) body.push(instruction);
    return [[header], ...body, [footer]].map((s) => s.join("\n")).join("\n");
  };
  while (sections.length > 0 && bytes(render()) > input.budget) {
    if (sections.pop()?.failure) omitted += 1;
  }
  return render();
}
