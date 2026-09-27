// ::playbook{env="lab" file="site.yml"} live card in chat: L0 summary, L1 plays and steps; the rest lives in the panel.
import { useState } from "react";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { EnvBadgeDto, PlaybookSummary, PlaySummary, TaskSummary } from "../shared/types.ts";
import { CHANNELS } from "../shared/constants.ts";
import { age, statusGlyph } from "../shared/format.ts";
import { runDetail } from "./run-summary-model.ts";
import type { RunSummaryDto } from "../schemas.ts";
import { EnvBadge } from "./badges.tsx";
import { DispatchMenu, useDispatch, type DispatchHandlers } from "./dispatch-menu.tsx";
import { fixInstruction, mentionLabel, parseErrorLabel } from "./dispatch-model.ts";
import { countsLine, parsePlaybookAttrs, whenText } from "./directive-attrs.ts";
import { usePlaybooksQuery } from "./hooks.ts";
import { useOpenPanel } from "./panel-open.ts";

const STEP_LIMIT = 8;

function Literal({ source }: { source: string }) {
  return <code className="text-xs text-muted-foreground">{source}</code>;
}

function Dashed({ children }: { children: React.ReactNode }) {
  return <div className="my-1 max-w-xl rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">{children}</div>;
}

function Menu({ target, plain, d }: { target: string; plain?: string; d: DispatchHandlers }) {
  const label = mentionLabel(target, plain);
  return <DispatchMenu target={target} label={label} onAddToChat={() => d.addToChat(target, label)} onNewThread={() => d.newThread(target, { label })} />;
}

function stepsOf(p: PlaySummary): TaskSummary[] {
  return [...p.preTasks, ...p.tasks, ...p.postTasks];
}

function PlayBlock({ play, target, index, firstNumber, d }: { play: PlaySummary; target: string; index: number; firstNumber: number; d: DispatchHandlers }) {
  const steps = stepsOf(play);
  const shown = steps.slice(0, STEP_LIMIT);
  const flags = [play.become ? "become" : null, play.serial ? `serial: ${play.serial}` : null].filter(Boolean).join(", ");
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Play {index + 1}</span>
        <span className="min-w-0 flex-1 truncate">{play.name} <span className="text-muted-foreground">→ {play.hosts}{flags ? ` (${flags})` : ""}</span></span>
        <Menu target={`${target}#${play.id}`} plain={play.name} d={d} />
      </div>
      <ol className="ml-4">
        {shown.map((t, i) => (
          <li key={t.id} className="flex items-center gap-2 text-xs">
            <span className="w-5 shrink-0 text-right text-muted-foreground">{firstNumber + i}</span>
            <span className="min-w-0 flex-1 truncate">{t.plain}</span>
            {t.when ? <span className="shrink-0 text-muted-foreground">{whenText(t.when)}</span> : null}
            <Menu target={`${target}#${t.id}`} plain={t.plain} d={d} />
          </li>
        ))}
      </ol>
      {steps.length > shown.length ? <div className="ml-4 pl-7 text-xs text-muted-foreground">…{steps.length - shown.length} more</div> : null}
    </div>
  );
}

function lastRunLine(r: RunSummaryDto): string {
  return `${statusGlyph(r.status)} ${runDetail(r, false)} · ${age(Date.now() - (r.endedAt ?? r.startedAt ?? r.requestedAt))} ago`;
}

function Card({ target, summary, lastRun, badge, d }: { target: string; summary: PlaybookSummary; lastRun: RunSummaryDto | null; badge: EnvBadgeDto; d: DispatchHandlers }) {
  const [open, setOpen] = useState(false);
  const openPanel = useOpenPanel();
  const handlers = summary.plays.flatMap((p) => p.handlers);
  const title = summary.name;
  let next = 1;
  return (
    <div className="my-1 max-w-xl rounded-lg border bg-card px-3 py-2">
      <div className="flex items-start gap-2">
        <button type="button" className="mt-0.5 w-4 shrink-0 text-xs text-muted-foreground" aria-expanded={open} aria-label={open ? "Collapse playbook" : "Expand playbook"} onClick={() => setOpen(!open)}>{open ? "▼" : "▶"}</button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <EnvBadge env={badge} />
            <span className="truncate">{summary.path}</span>
            <span className="truncate font-normal text-muted-foreground">{title}</span>
          </div>
          <div className="truncate text-xs text-muted-foreground">{countsLine(summary.counts, summary.targets)}</div>
          {lastRun ? <div className="truncate text-xs text-muted-foreground">last run: {lastRunLine(lastRun)}</div> : null}
        </div>
        <Menu target={target} d={d} />
      </div>
      {open ? (
        <div className="mt-2 space-y-1 pl-6">
          {summary.plays.map((p, i) => {
            const first = next;
            next += stepsOf(p).length;
            return <PlayBlock key={p.id} play={p} target={target} index={i} firstNumber={first} d={d} />;
          })}
          {handlers.length ? <div className="text-xs text-muted-foreground">Handlers: {handlers.map((h) => h.plain).join(", ")}</div> : null}
          {summary.warnings.length ? <div className="text-xs text-amber-600 dark:text-amber-400">⚠ {summary.warnings.length} warning{summary.warnings.length === 1 ? "" : "s"}: {summary.warnings[0]!.message}</div> : null}
        </div>
      ) : null}
      {open ? (
        <div className="mt-2 flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => openPanel({ target, view: "list", run: true }, title)}>Run ▸</Button>
          <Button variant="ghost" size="sm" onClick={() => openPanel({ target }, title)}>Open panel ▸</Button>
          <Button variant="ghost" size="sm" onClick={() => openPanel({ target, view: "graph" }, title)}>Graph ▸</Button>
        </div>
      ) : (
        <div className="mt-1 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => openPanel({ target }, title)}>Open panel ▸</Button>
        </div>
      )}
    </div>
  );
}

function Inner({ env, file, threadId, source }: { env: string; file: string; threadId: string; source: string }) {
  const target = `${env}/${file}`;
  const q = usePlaybooksQuery("playbook.summary", { env, file, threadId }, { refreshOn: [CHANNELS.changed, CHANNELS.run] });
  const overview = usePlaybooksQuery("overview", {}, { refreshOn: [CHANNELS.changed] });
  const openPanel = useOpenPanel();
  const d = useDispatch();
  const badge = overview.data?.envs.find((e) => e.env.slug === env)?.env;
  if (!q.data) return q.error ? <Dashed>Could not load {target}: {q.error} <Button variant="link" size="sm" onClick={q.refresh}>Retry</Button></Dashed> : <div className="my-1 h-14 max-w-xl animate-pulse rounded-lg border bg-muted/40" />;
  const data = q.data;
  if (!data.found) {
    if (data.reason === "unknown-env") return <Literal source={source} />;
    if (data.reason === "not-found") return <Dashed>{file} not found in {env}</Dashed>;
    return <Dashed>{data.message} <Button variant="link" size="sm" onClick={q.refresh}>Retry</Button></Dashed>;
  }
  if (!badge) return overview.data ? <Literal source={source} /> : <div className="my-1 h-14 max-w-xl animate-pulse rounded-lg border bg-muted/40" />;
  const err = data.summary.error;
  if (err) {
    return (
      <div className="my-1 max-w-xl rounded-lg border border-destructive/50 bg-card px-3 py-2 text-xs">
        <div className="flex items-center gap-2"><EnvBadge env={badge} /><span className="font-medium">{file}</span></div>
        <div className="mt-1 text-destructive">could not parse: line {err.line} {err.message}</div>
        <div className="mt-1 flex gap-1">
          <Button variant="outline" size="sm" onClick={() => d.addToChat(target, parseErrorLabel(file, err), fixInstruction(file, err))}>Ask agent to fix</Button>
          <Button variant="ghost" size="sm" onClick={() => openPanel({ target }, data.summary.name)}>Open panel ▸</Button>
        </div>
        {d.dialog}
      </div>
    );
  }
  return <><Card target={target} summary={data.summary} lastRun={data.lastRun} badge={badge} d={d} />{d.dialog}</>;
}

export function PlaybookDirective({ attributes, source, message }: PluginMessageDirectiveProps) {
  const attrs = parsePlaybookAttrs(attributes);
  return attrs ? <Inner env={attrs.env} file={attrs.file} threadId={message.threadId} source={source} /> : <Literal source={source} />;
}
