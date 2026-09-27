// Run matrix: plays × tasks × hosts with per-cell glyphs, failure messages, recap, raw log, and footer actions.
import { useState } from "react";
import { Markdown, experimental_SourceCode as SourceCode } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CHANNELS } from "../shared/constants.ts";
import { elapsed, l0Line } from "../shared/format.ts";
import type { RunSpec, RunView as RunViewDto } from "../shared/types.ts";
import { CellGlyph } from "./badges.tsx";
import { CellDetail } from "./cell-detail.tsx";
import { investigationLine } from "./dispatch-model.ts";
import { useDispatch, type RunScope } from "./dispatch-menu.tsx";
import { usePlaybooksQuery, usePlaybooksRpc, useNow } from "./hooks.ts";
import { useOpenPanel } from "./panel-open.ts";
import { RunDialog } from "./run-dialog.tsx";
import { failedHosts, failedCount, failureMessages, playFailed, recapLine, taskKey, taskState } from "./run-view-model.ts";

const THREAD_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const RAW_PAGE = 65_536;
const ACTIVE = new Set(["queued", "starting", "running"]);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const isActive = (status: string) => ACTIVE.has(status);


export function StopButton({ runId }: { runId: string }) {
  const call = usePlaybooksRpc();
  return (
    <Button variant="ghost" size="icon" className="size-6" aria-label="Stop run" onClick={() => void call("run.cancel", { runId, force: false }).catch((e: unknown) => toast.error(`Could not stop the run: ${errorText(e)}`))}>
      <span aria-hidden>■</span>
    </Button>
  );
}

export function InvestigationLines({ view }: { view: RunViewDto }) {
  return (
    <>
      {view.investigations.filter((i) => THREAD_ID_RE.test(i.threadId)).map((i) => (
        <Markdown key={i.threadId} className="text-xs" content={investigationLine(i)} />
      ))}
    </>
  );
}

function RawLog({ runId }: { runId: string }) {
  const call = usePlaybooksRpc();
  const [state, setState] = useState<{ text: string; offset: number; size: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const more = async () => {
    setBusy(true);
    try {
      const at = state?.offset ?? 0;
      const r = await call("run.raw", { runId, offset: at, bytes: RAW_PAGE });
      setState({ text: (state?.text ?? "") + r.text, offset: at + r.read, size: r.size });
    } catch (e) {
      toast.error(`Could not load the log: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  if (!state) return <Button variant="ghost" size="sm" disabled={busy} onClick={() => void more()}>Raw log ▸</Button>;
  return (
    <div className="space-y-1">
      <div className="max-h-72 overflow-auto rounded-md border"><SourceCode content={state.text || "(empty)"} path="run.log" overflow="wrap" /></div>
      {state.offset < state.size ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void more()}>Load more ({Math.round((state.size - state.offset) / 1024)} KB left)</Button> : null}
    </div>
  );
}

interface Props { runId: string; compact?: boolean; hideHeader?: boolean; onCell?(host: string, node: string): void }

export function RunView({ runId, compact = false, hideHeader = false, onCell }: Props) {
  const q = usePlaybooksQuery("run.view", { runId }, { refreshOn: [CHANNELS.run] });
  const failedEv = usePlaybooksQuery("run.events", { runId, cursor: 0, limit: 1000, failedOnly: true, light: true }, { refreshOn: [CHANNELS.run] });
  const openPanel = useOpenPanel();
  const dispatch = useDispatch();
  const now = useNow(1000);
  const [cell, setCell] = useState<{ host: string; node: string; playIndex: number; taskIndex: number } | null>(null);
  const [rerun, setRerun] = useState<{ limit: string } | null>(null);

  if (!q.data) return q.error ? <div className="text-xs text-destructive">Could not load the run: {q.error} <Button variant="link" size="sm" onClick={q.refresh}>Retry</Button></div> : <div className="h-20 animate-pulse rounded-lg border bg-muted/40" />;
  if (!q.data.found) return <div className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">Run {runId} was not found.</div>;
  const { view, spec } = q.data;
  const messages = failureMessages(failedEv.data?.events ?? []);
  const bad = failedHosts(view);
  const investigate = (scope: RunScope) => dispatch.investigate(runId, scope);
  const pick = (host: string, node: string | null, playIndex: number, taskIndex: number) => {
    if (!node) return;
    if (onCell) onCell(host, node);
    else setCell((c) => (c?.host === host && c.playIndex === playIndex && c.taskIndex === taskIndex ? null : { host, node, playIndex, taskIndex }));
  };
  const cols = compact && view.hosts.length > 4 ? view.hosts.slice(0, 4) : view.hosts;
  const active = isActive(view.status);
  const l0 = l0Line(view, now, spec ? { inventory: spec.inventory || "default inventory", check: spec.check } : undefined);

  return (
    <div className="space-y-2 text-xs">
      {hideHeader ? null : (
        <>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{l0}</span>
            <span className="tabular-nums text-muted-foreground">{elapsed(view.startedAt, view.endedAt, now)}</span>
            {active ? <StopButton runId={runId} /> : null}
          </div>
          <div className="text-muted-foreground">{view.hosts.length} hosts · {failedCount(view.counters)} failed · {view.counters.changed} changed</div>
          <InvestigationLines view={view} />
        </>
      )}
      {view.lastLine && active ? <div className="truncate text-muted-foreground">{view.lastLine}</div> : null}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-muted-foreground">
              <th className="sticky left-0 bg-card px-2 py-1 text-left font-normal" />
              {cols.map((h) => <th key={h} className="px-1.5 py-1 text-center font-normal" title={h}>{h}</th>)}
            </tr>
          </thead>
          {view.plays.map((p, pi) => (
            <tbody key={p.id} className="border-t">
              <tr>
                <td colSpan={cols.length + 1} className="sticky left-0 bg-card px-2 py-1 font-medium">Play {pi + 1} <span className="font-normal">{p.name}</span>{playFailed(p) ? <span className="ml-2 text-destructive">failed</span> : null}</td>
              </tr>
              {p.tasks.map((t, ti) => {
                const st = taskState(t);
                const msgs = messages.get(taskKey(p.name, t.name)) ?? [];
                return [
                  <tr key={`${p.id}/${ti}`}>
                    <td className="sticky left-0 max-w-56 truncate bg-card py-0.5 pl-4 pr-2"><CellGlyph state={st} className="mr-1" />{t.name}</td>
                    {cols.map((h) => (
                      <td key={h} className="px-1.5 py-0.5 text-center">
                        {t.cells[h] ? (
                          <button type="button" className={cn("rounded px-1 hover:bg-state-hover", t.nodeId ? "cursor-pointer" : "cursor-default")} onClick={() => pick(h, t.nodeId, pi, ti)} aria-label={`${h}: ${t.cells[h]}`}>
                            <CellGlyph state={t.cells[h]!} />
                          </button>
                        ) : null}
                      </td>
                    ))}
                  </tr>,
                  ...(st === "failed" || st === "unreachable" ? [
                    <tr key={`${p.id}/${ti}/msg`}>
                      <td colSpan={cols.length + 1} className="pb-1 pl-8 pr-2">
                        {msgs.map((m) => <div key={m.host} className="break-words text-destructive">{m.host}: {m.msg}</div>)}
                        <Button variant="outline" size="sm" onClick={() => investigate(t.nodeId ? { node: t.nodeId } : {})}>Investigate ▸</Button>
                      </td>
                    </tr>,
                  ] : []),
                  ...(cell && cell.playIndex === pi && cell.taskIndex === ti && !onCell ? [
                    <tr key={`${p.id}/${ti}/cell`}>
                      <td colSpan={cols.length + 1} className="px-2 pb-1"><CellDetail runId={runId} host={cell.host} node={cell.node} playIndex={cell.playIndex} taskIndex={cell.taskIndex} onInvestigate={() => investigate(cell)} /></td>
                    </tr>,
                  ] : []),
                ];
              })}
            </tbody>
          ))}
        </table>
      </div>
      {view.hosts.length > cols.length ? <div className="text-muted-foreground">+{view.hosts.length - cols.length} more hosts in the panel</div> : null}
      <div className="text-muted-foreground"><span className="font-medium text-foreground">Recap</span>  {recapLine(view.counters)}</div>
      <div className="flex flex-wrap items-center gap-1">
        {!active && spec ? <Button variant="outline" size="sm" onClick={() => setRerun({ limit: spec.limit })}>Rerun ▸</Button> : null}
        {!active && spec && bad.length ? <Button variant="outline" size="sm" onClick={() => setRerun({ limit: bad.join(",") })}>Rerun failed hosts ▸</Button> : null}
        {bad.length ? <Button variant="outline" size="sm" onClick={() => investigate({})}>Investigate all ▸</Button> : null}
        {compact ? <Button variant="ghost" size="sm" onClick={() => openPanel({ runId }, "Run")}>Open panel ▸</Button> : null}
      </div>
      {!compact ? <RawLog runId={runId} /> : null}
      {rerun && spec ? <RunDialog env={view.env.slug} file={view.playbook} open surface="panel" initialSpec={{ ...spec, limit: rerun.limit }} onClose={() => setRerun(null)} /> : null}
    </div>
  );
}
