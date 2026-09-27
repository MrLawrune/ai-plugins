// ::playbook-run{id="run_7f3a"} live card in chat: L0 line with a stop button while running, L1 matrix when opened.
import { useState } from "react";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { CHANNELS } from "../shared/constants.ts";
import { l0Line } from "../shared/format.ts";
import { usePlaybooksQuery, useNow } from "./hooks.ts";
import { useOpenPanel } from "./panel-open.ts";
import { parseRunAttrs } from "./run-attrs.ts";
import { failedCount } from "./run-view-model.ts";
import { InvestigationLines, RunView, StopButton, isActive } from "./run-view.tsx";

function Literal({ source }: { source: string }) {
  return <code className="text-xs text-muted-foreground">{source}</code>;
}

function Card({ runId }: { runId: string }) {
  const q = usePlaybooksQuery("run.view", { runId }, { refreshOn: [CHANNELS.run] });
  const [open, setOpen] = useState(false);
  const openPanel = useOpenPanel();
  const now = useNow(1000);
  if (!q.data) return q.error ? <div className="my-1 max-w-xl rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">Could not load the run: {q.error} <Button variant="link" size="sm" onClick={q.refresh}>Retry</Button></div> : <div className="my-1 h-14 max-w-xl animate-pulse rounded-lg border bg-muted/40" />;
  if (!q.data.found) return <div className="my-1 max-w-xl rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">Run {runId} was not found.</div>;
  const { view, spec } = q.data;
  const bad = failedCount(view.counters);
  return (
    <div className="my-1 max-w-xl rounded-lg border bg-card px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{l0Line(view, now, spec ? { inventory: spec.inventory || "default inventory", check: spec.check } : undefined)}</div>
          <div className="truncate text-xs text-muted-foreground">{view.hosts.length} hosts · {bad} failed · {view.counters.changed} changed{view.lastLine && isActive(view.status) ? ` · ${view.lastLine}` : ""}</div>
          <InvestigationLines view={view} />
        </div>
        {isActive(view.status) ? <StopButton runId={runId} /> : null}
        <Button variant="ghost" size="icon" className="size-6" aria-expanded={open} aria-label={open ? "Collapse run" : "Expand run"} onClick={() => setOpen(!open)}><span aria-hidden>{open ? "⌃" : "⌄"}</span></Button>
      </div>
      {open ? <div className="mt-2"><RunView runId={runId} compact hideHeader onCell={() => openPanel({ runId }, "Run")} /></div> : (
        <div className="mt-1 flex justify-end"><Button variant="ghost" size="sm" onClick={() => openPanel({ runId }, "Run")}>Open panel ▸</Button></div>
      )}
    </div>
  );
}

export function RunDirective({ attributes, source }: PluginMessageDirectiveProps) {
  const attrs = parseRunAttrs(attributes);
  return attrs ? <Card runId={attrs.id} /> : <Literal source={source} />;
}
