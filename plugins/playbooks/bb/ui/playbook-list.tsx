// Panel list view: plays and steps (L1), one step expanded (L2), handlers, variables, raw YAML, last runs.
import { useState, type ReactNode } from "react";
import { experimental_SourceCode as SourceCode } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { RunSummaryDto } from "../schemas.ts";
import { CHANNELS } from "../shared/constants.ts";
import { age, statusGlyph } from "../shared/format.ts";
import { runRowText } from "./run-summary-model.ts";
import type { PlaybookSummary, PlaySummary, TaskSummary } from "../shared/types.ts";
import { whenText } from "./directive-attrs.ts";
import { DispatchMenu } from "./dispatch-menu.tsx";
import { usePlaybooksQuery } from "./hooks.ts";
import { L2Block } from "./l2-block.tsx";
import { useOpenPanel } from "./panel-open.ts";

/** `label` is the step's or play's plain text for the pill and the dialog title. */
export interface ListDispatch { onAddToChat(target: string, label?: string): void; onNewThread(target: string, label?: string): void }

export interface PlaybookListProps {
  env: string;
  file: string;
  summary: PlaybookSummary;
  content: string | null;
  selected: string | null;
  onSelect(nodeId: string | null): void;
  dispatch: ListDispatch;
}

export function stepsOf(p: PlaySummary): TaskSummary[] {
  return [...p.preTasks, ...p.tasks, ...p.postTasks];
}

/** Every task in the summary, children included, keyed by node id. */
export function findNode(summary: PlaybookSummary, id: string): TaskSummary | null {
  const walk = (ts: TaskSummary[]): TaskSummary | null => {
    for (const t of ts) {
      if (t.id === id) return t;
      const c = t.children;
      const hit = c ? walk([...c.block, ...c.rescue, ...c.always]) : null;
      if (hit) return hit;
    }
    return null;
  };
  for (const p of summary.plays) {
    const hit = walk([...stepsOf(p), ...p.handlers]);
    if (hit) return hit;
  }
  return null;
}

function Section({ title, defaultOpen = false, aside, children }: { title: string; defaultOpen?: boolean; aside?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <div className="flex items-center gap-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-1.5 py-1 text-left text-sm font-medium hover:text-foreground">
          <span className="w-3 text-xs text-muted-foreground">{open ? "▾" : "▸"}</span>{title}
        </button>
        {aside}
      </div>
      {open ? <div className="pl-4">{children}</div> : null}
    </section>
  );
}

interface StepCtx { file: string; env: string; selected: string | null; onSelect(id: string | null): void; dispatch: ListDispatch; playBecome: boolean | null }

function Step({ t, number, depth, ctx }: { t: TaskSummary; number?: number; depth: number; ctx: StepCtx }) {
  const target = `${ctx.env}/${ctx.file}#${t.id}`;
  const open = ctx.selected === t.id;
  const kids = t.children ? [["block", t.children.block], ["rescue", t.children.rescue], ["always", t.children.always]] as const : [];
  return (
    <li>
      <div className={cn("flex items-center gap-2 rounded px-1 text-sm hover:bg-state-hover", open && "bg-state-hover")} style={{ paddingLeft: depth * 12 + 4 }}>
        <button type="button" aria-expanded={open} onClick={() => ctx.onSelect(open ? null : t.id)} className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left">
          <span className="w-3 shrink-0 text-xs text-muted-foreground">{open ? "▾" : "▸"}</span>
          {number !== undefined ? <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">{number}</span> : null}
          <span className="min-w-0 flex-1 truncate">{t.plain}</span>
          {t.when ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{whenText(t.when)}</span> : null}
        </button>
        <DispatchMenu target={target} onAddToChat={() => ctx.dispatch.onAddToChat(target, t.plain)} onNewThread={() => ctx.dispatch.onNewThread(target, t.plain)} />
      </div>
      {open ? <div style={{ paddingLeft: depth * 12 + 24 }}><L2Block t={t} target={target} dispatch={ctx.dispatch} playBecome={ctx.playBecome} /></div> : null}
      {kids.map(([label, list]) => list.length ? (
        <ul key={label}>
          <li className="text-xs text-muted-foreground" style={{ paddingLeft: (depth + 1) * 12 + 24 }}>{label}</li>
          {list.map((c) => <Step key={c.id} t={c} depth={depth + 1} ctx={ctx} />)}
        </ul>
      ) : null)}
    </li>
  );
}

function Play({ play, index, first, ctx }: { play: PlaySummary; index: number; first: number; ctx: StepCtx }) {
  const target = `${ctx.env}/${ctx.file}#${play.id}`;
  const flags = [play.become ? "become" : null, play.gatherFacts === false ? "no facts" : play.gatherFacts ? "gather facts" : null, play.serial ? `serial ${play.serial}` : null].filter(Boolean).join(" · ");
  const steps = stepsOf(play);
  const playCtx = { ...ctx, playBecome: play.become };
  return (
    <Section
      title={`Play ${index + 1} · ${play.name} · hosts: ${play.hosts}${flags ? ` · ${flags}` : ""}`}
      defaultOpen={index === 0}
      aside={<DispatchMenu target={target} onAddToChat={() => ctx.dispatch.onAddToChat(target, play.name)} onNewThread={() => ctx.dispatch.onNewThread(target, play.name)} />}
    >
      {play.vars.keys.length || play.roles.length ? (
        <div className="flex flex-wrap gap-x-4 pb-1 text-xs text-muted-foreground">
          {play.vars.keys.length ? <span>vars: {play.vars.keys.join(", ")} ({play.vars.keys.length})</span> : null}
          {play.roles.length ? <span>roles: {play.roles.map((r) => r.name).join(", ")}</span> : null}
        </div>
      ) : null}
      <ol>{steps.map((t, i) => <Step key={t.id} t={t} number={first + i} depth={0} ctx={playCtx} />)}</ol>
      {steps.length === 0 ? <div className="text-xs text-muted-foreground">No steps</div> : null}
    </Section>
  );
}

function LastRuns({ env, file }: { env: string; file: string }) {
  const q = usePlaybooksQuery("runs.list", { env, file, limit: 5 }, { refreshOn: [CHANNELS.run] });
  const openPanel = useOpenPanel();
  const runs: RunSummaryDto[] = q.data?.runs ?? [];
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last runs</h3>
      {q.error ? <div className="text-xs text-destructive">Could not load runs: {q.error}</div> : null}
      {q.data && !runs.length ? <div className="text-xs text-muted-foreground">No runs yet</div> : null}
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => openPanel({ runId: r.id }, r.playbookName)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-state-hover">
              <span>{statusGlyph(r.status)}</span>
              <span className="min-w-0 flex-1 truncate">{runRowText(r)}</span>
              <span className="shrink-0 text-muted-foreground">{age(Date.now() - (r.endedAt ?? r.startedAt ?? r.requestedAt))} ago</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PlaybookList({ env, file, summary, content, selected, onSelect, dispatch }: PlaybookListProps) {
  const ctx: StepCtx = { env, file, selected, onSelect, dispatch, playBecome: null };
  const handlers = summary.plays.flatMap((p) => p.handlers.map((h) => ({ h, become: p.become })));
  const varsCount = summary.plays.reduce((n, p) => n + p.vars.keys.length, 0);
  const varFiles = summary.plays.reduce((n, p) => n + p.vars.files.length, 0);
  const node = selected ? findNode(summary, selected) : null;
  let next = 1;
  return (
    <div className="space-y-2">
      {summary.plays.map((p, i) => {
        const first = next;
        next += stepsOf(p).length;
        return <Play key={p.id} play={p} index={i} first={first} ctx={ctx} />;
      })}
      {handlers.length ? (
        <Section title={`Handlers (${handlers.length})`}>
          <ul>{handlers.map(({ h, become }) => <Step key={h.id} t={h} depth={0} ctx={{ ...ctx, playBecome: become }} />)}</ul>
        </Section>
      ) : null}
      {varsCount || varFiles ? (
        <Section title={`Variables (${varsCount} play var${varsCount === 1 ? "" : "s"}, ${varFiles} vars_file${varFiles === 1 ? "" : "s"})`}>
          <ul className="text-xs text-muted-foreground">
            {summary.plays.flatMap((p) => [...p.vars.keys, ...p.vars.files.map((f) => `${f} (file)`)].map((v) => <li key={`${p.id}:${v}`} className="font-mono">{v}</li>))}
          </ul>
        </Section>
      ) : null}
      <Section title="Raw YAML">
        {content === null ? <div className="text-xs text-muted-foreground">Loading…</div> : (
          <SourceCode content={content} path={file} highlightedLines={node ? { start: node.line, end: node.endLine } : null} />
        )}
      </Section>
      <LastRuns env={env} file={file} />
    </div>
  );
}
