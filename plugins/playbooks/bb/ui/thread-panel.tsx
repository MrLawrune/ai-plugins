// Thread side panel: the thread's playbooks and runs, environments with their library, and playbook detail (list view).
import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { parseTarget } from "../server/targets.ts";
import type { RunSummaryDto } from "../schemas.ts";
import type { PlaybookSummary } from "../shared/types.ts";
import { CHANNELS } from "../shared/constants.ts";
import { age, statusGlyph, statusLabel } from "../shared/format.ts";
import { EnvBadge, HealthBadge } from "./badges.tsx";
import { countsLine } from "./directive-attrs.ts";
import { DispatchMenu, useDispatch, type DispatchHandlers } from "./dispatch-menu.tsx";
import { GraphLoader } from "./graph-loader.tsx";
import { DispatchActions, L2Block } from "./l2-block.tsx";
import { usePlaybooksQuery, useNow } from "./hooks.ts";
import { panelParams, type PanelView } from "./panel-params.ts";
import { RunView } from "./run-view.tsx";
import { RunDialog } from "./run-dialog.tsx";
import { resolveNode } from "./node-resolver.ts";
import { PlaybookList, type ListDispatch } from "./playbook-list.tsx";

export const PANEL_ACTION_ID = "playbooks";
const PLUGIN_ID = "playbooks";

type Entry = Exclude<PanelView, { kind: "root" }>;
const listDispatch = (d: DispatchHandlers): ListDispatch => ({ onAddToChat: (t, label) => d.addToChat(t, label), onNewThread: (t, label) => d.newThread(t, { label }) });

const entryOf = (params: unknown): Entry[] => { const v = panelParams(params); return v.kind === "root" ? [] : [v]; };

function RunRow({ r, onOpen, now }: { r: RunSummaryDto; onOpen(): void; now: number }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-state-hover">
      <span>{statusGlyph(r.status)}</span>
      <span className="min-w-0 flex-1 truncate">{r.playbookName} · {statusLabel(r.status).toLowerCase()}{r.check ? " · check" : ""}</span>
      <EnvBadge env={r.env} className="hidden sm:inline-flex" />
      <span className="text-xs tabular-nums text-muted-foreground">{age(now - (r.endedAt ?? r.startedAt ?? r.requestedAt))}</span>
    </button>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

function EnvLibrary({ slug, onOpen }: { slug: string; onOpen(target: string): void }) {
  const q = usePlaybooksQuery("library.list", { env: slug }, { refreshOn: [CHANNELS.changed] });
  if (q.error) return <div className="pl-2 text-xs text-destructive">Could not load library: {q.error}</div>;
  if (!q.data) return <div className="pl-2 text-xs text-muted-foreground">Loading…</div>;
  if (!q.data.entries.length) return <div className="pl-2 text-xs text-muted-foreground">No playbooks found</div>;
  return (
    <ul className="space-y-0.5 pl-2">
      {q.data.entries.map((e) => (
        <li key={e.path}>
          <button type="button" onClick={() => onOpen(`${slug}/${e.path}`)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-state-hover">
            <span className="min-w-0 flex-1 truncate">{e.path} <span className="text-muted-foreground">{e.name}</span></span>
            <span className="shrink-0 text-muted-foreground">{e.counts.steps} steps</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Root({ threadId, onOpen, onOpenRun }: { threadId: string; onOpen(target: string): void; onOpenRun(id: string): void }) {
  const mine = usePlaybooksQuery("thread.playbooks", { threadId }, { refreshOn: [CHANNELS.changed, CHANNELS.run] });
  const overview = usePlaybooksQuery("overview", {}, { refreshOn: [CHANNELS.changed, CHANNELS.run] });
  const now = useNow();
  const files = mine.data?.files ?? [];
  const runs = mine.data?.runs ?? [];
  return (
    <div className="space-y-4">
      {mine.error ? <div className="text-xs text-destructive">Could not load this thread's playbooks: {mine.error}</div> : null}
      {files.length ? (
        <section className="space-y-1.5">
          <Heading>Touched by this thread</Heading>
          <ul className="space-y-1">
            {files.map((f) => (
              <li key={`${f.env.slug}/${f.path}`}>
                <button type="button" onClick={() => onOpen(`${f.env.slug}/${f.path}`)} className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-state-hover">
                  <span className="min-w-0 flex-1 truncate">{f.path} <span className="text-muted-foreground">{f.name}</span></span>
                  <EnvBadge env={f.env} className="hidden sm:inline-flex" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {runs.length ? (
        <section className="space-y-1.5">
          <Heading>Runs from this thread</Heading>
          <ul className="space-y-1">{runs.map((r) => <li key={r.id}><RunRow r={r} now={now} onOpen={() => onOpenRun(r.id)} /></li>)}</ul>
        </section>
      ) : null}
      <section className="space-y-2">
        <Heading>Environments</Heading>
        {overview.error ? <div className="text-xs text-destructive">Could not load environments: {overview.error}</div> : null}
        {overview.data && !overview.data.envs.length ? <div className="text-xs text-muted-foreground">No environments yet. Add one in Settings → Plugins → Playbooks.</div> : null}
        {overview.data?.envs.map((e) => (
          <div key={e.env.slug} className="space-y-1">
            <div className="flex items-center gap-2">
              <EnvBadge env={e.env} />
              <HealthBadge code={e.health} />
              {e.running ? <span className="text-xs text-muted-foreground">{e.running} running</span> : null}
            </div>
            {e.health === "ok" || e.health === "degraded" ? <EnvLibrary slug={e.env.slug} onOpen={onOpen} /> : null}
          </div>
        ))}
      </section>
    </div>
  );
}

function GraphView({ env, file, summary, target, selected, onSelect, dispatch }: { env: string; file: string; summary: PlaybookSummary; target: string; selected: string | null; onSelect(id: string | null): void; dispatch: ListDispatch }) {
  const node = selected ? resolveNode(summary, selected) : null;
  const nodeTarget = `${env}/${file}#${selected}`;
  return (
    <div className="space-y-2">
      <GraphLoader target={target} runId={null} selected={selected} onSelect={onSelect} />
      {node?.kind === "task" || node?.kind === "handler" ? <L2Block t={node.t} target={nodeTarget} dispatch={dispatch} playBecome={node.play.become} /> : null}
      {node?.kind === "play" || node?.kind === "role" ? (
        <div className="mb-1 space-y-0.5 rounded-md border bg-card px-2 py-1.5 text-xs">
          <div className="truncate font-medium">{node.kind === "play" ? `Play · ${node.play.name} · hosts: ${node.play.hosts}` : `role ${node.name} · ${node.play.name}`}</div>
          <DispatchActions target={nodeTarget} label={node.kind === "play" ? node.play.name : node.name} dispatch={dispatch} />
        </div>
      ) : null}
    </div>
  );
}

function PlaybookDetail({ target, viewParam, runParam, onViewChange, dispatch }: { target: string; viewParam: "list" | "graph" | null; runParam: boolean; onViewChange(v: "list" | "graph"): void; dispatch: ListDispatch }) {
  const t = parseTarget(target)!;
  const env = t.env, file = t.path!;
  const q = usePlaybooksQuery("playbook.summary", { env, file }, { refreshOn: [CHANNELS.changed] });
  const raw = usePlaybooksQuery("playbook.raw", { env, file }, { refreshOn: [CHANNELS.changed] });
  const overview = usePlaybooksQuery("overview", {}, { refreshOn: [CHANNELS.changed] });
  const [selected, setSelected] = useState<string | null>(t.node ?? null);
  useEffect(() => setSelected(t.node ?? null), [t.node, target]);
  const [runOpen, setRunOpen] = useState(runParam);
  const [viaCard, setViaCard] = useState(runParam);

  if (!q.data) return q.error ? <div className="text-xs text-destructive">Could not load {target}: {q.error} <Button variant="link" size="sm" onClick={q.refresh}>Retry</Button></div> : <div className="h-14 animate-pulse rounded-lg border bg-muted/40" />;
  const d = q.data;
  if (!d.found) return <div className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">{d.reason === "not-found" ? `${file} not found in ${env}` : d.message} <Button variant="link" size="sm" onClick={q.refresh}>Retry</Button></div>;
  const s = d.summary;
  const badge = overview.data?.envs.find((e) => e.env.slug === env)?.env;
  const view = viewParam ?? (s.counts.plays === 1 ? "list" : "graph");
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          {badge ? <EnvBadge env={badge} /> : null}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{file} <span className="font-normal text-muted-foreground">{s.name}</span></span>
          <div className="flex shrink-0 rounded-md border text-xs">
            {(["list", "graph"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => onViewChange(v)} className={cn("px-2 py-0.5 capitalize first:rounded-l-md last:rounded-r-md", view === v ? "bg-state-hover text-foreground" : "text-muted-foreground hover:text-foreground")}>{v}</button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => setRunOpen(true)}>Run ▸</Button>
          <DispatchMenu target={target} onAddToChat={() => dispatch.onAddToChat(target, s.name)} onNewThread={() => dispatch.onNewThread(target, s.name)} />
        </div>
        <div className="text-xs text-muted-foreground">{countsLine(s.counts, s.targets)}{s.error ? "" : " · ✓ syntax ok"}</div>
      </div>
      <RunDialog env={env} file={file} open={runOpen} surface={viaCard ? "card" : "panel"} onClose={() => { setRunOpen(false); setViaCard(false); }} />
      {s.error ? <div className="rounded-lg border border-destructive/50 px-3 py-2 text-xs text-destructive">could not parse: line {s.error.line} {s.error.message}</div> : null}
      {s.warnings.length ? <div className="text-xs text-amber-600 dark:text-amber-400">⚠ {s.warnings.length} warning{s.warnings.length === 1 ? "" : "s"}: {s.warnings[0]!.message}</div> : null}
      {view === "graph"
        ? <GraphView env={env} file={file} summary={s} target={target} selected={selected} onSelect={setSelected} dispatch={dispatch} />
        : <PlaybookList env={env} file={file} summary={s} content={raw.data?.content ?? null} selected={selected} onSelect={setSelected} dispatch={dispatch} />}
    </div>
  );
}

export function ThreadPlaybooksPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const nav = useBbNavigate();
  const sdk = useSdk();
  const actions = useDispatch();
  const dispatch = listDispatch(actions);
  const initial = entryOf(params);
  const [stack, setStack] = useState<Entry[]>(initial);
  useEffect(() => { setStack(entryOf(params)); }, [params]);
  const current = stack.at(-1) ?? null;
  const push = (e: Entry) => setStack((s) => [...s, e]);
  const back = () => setStack((s) => s.slice(0, -1));
  const setView = (v: "list" | "graph") => setStack((s) => s.map((e, i) => (i === s.length - 1 && e.kind === "playbook" ? { ...e, view: v } : e)));

  // Title follows what the panel shows; re-opening with the same params refreshes the tab title.
  const target = current?.kind === "playbook" ? parseTarget(current.target) : null;
  const name = usePlaybooksQuery("playbook.summary", target?.path ? { env: target.env, file: target.path } : null, { refreshOn: [] });
  const title = current?.kind === "run" ? "Run" : current ? (name.data?.found ? name.data.summary.name : target?.path ?? "Playbooks") : "Playbooks";
  const shownTitle = useRef<string | null>(null);
  // Same params as the tab was opened with, so BB matches the tab and only its title changes.
  const own = initial.length ? (params as { [k: string]: string | boolean }) : undefined;
  useEffect(() => {
    if (shownTitle.current === title) return;
    shownTitle.current = title;
    nav.openThreadPanel({ actionId: PANEL_ACTION_ID, title, ...(own ? { params: own } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, nav]);

  const close = async () => {
    try {
      const { revision, tabs } = await sdk.threads.tabs.get({ threadId });
      const ownJson = JSON.stringify(params ?? null);
      const next = tabs.filter((t) => {
        const x = t as { kind: string; pluginId?: string; actionId?: string; paramsJson?: string | null };
        if (x.kind !== "plugin-panel" || x.pluginId !== PLUGIN_ID || x.actionId !== PANEL_ACTION_ID) return true;
        try { return JSON.stringify(x.paramsJson ? JSON.parse(x.paramsJson) : null) !== ownJson; } catch { return true; }
      });
      await sdk.threads.tabs.update({ threadId, expectedRevision: revision, tabs: next });
    } catch (e) {
      toast.error(`Could not close the Playbooks tab: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        {current ? (
          <button type="button" onClick={back} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <Icon name="ChevronLeft" className="size-3.5" /> Back
          </button>
        ) : <span />}
        <button type="button" onClick={() => void close()} aria-label="Close this Playbooks tab" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
          <Icon name="X" className="size-3.5" /> Close
        </button>
      </div>
      {!current ? <Root threadId={threadId} onOpen={(t) => push({ kind: "playbook", target: t, view: null, run: false })} onOpenRun={(runId) => push({ kind: "run", runId })} />
        : current.kind === "run" ? <RunView key={current.runId} runId={current.runId} />
        : <PlaybookDetail key={current.target} target={current.target} viewParam={current.view} runParam={current.run} onViewChange={setView} dispatch={dispatch} />}
      {actions.dialog}
    </div>
  );
}
