// Agent activity and inventory changes, newest first.
import { ThreadTitle, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { ActivityDto, ChangeDto } from "../schemas.ts";
import { age } from "./format.ts";
import { useInfraQuery, useNow } from "./hooks.ts";

type Row = { kind: "cmd"; at: number; a: ActivityDto; more: number } | { kind: "change"; at: number; c: ChangeDto };

const CHANGE_TEXT: Record<ChangeDto["kind"], string> = { "guest.added": "created", "guest.removed": "removed", "guest.state": "changed state", "host.state": "host changed state" };

/** One row per command run: started+completed collapse, and a run touching a host and its guest shows the most specific target. */
function rowsOf(items: ActivityDto[], changes: ChangeDto[]): Row[] {
  const runs = new Map<string, { a: ActivityDto; targets: string[] }>();
  for (const a of items) {
    const key = `${a.threadId}|${a.itemId}`;
    const run = runs.get(key);
    if (!run) { runs.set(key, { a, targets: [a.target] }); continue; }
    if (!run.targets.includes(a.target)) run.targets.push(a.target);
    if (run.a.phase === "started" && a.phase === "completed") run.a = { ...a, target: run.a.target };
  }
  const cmds: Row[] = [...runs.values()].map(({ a, targets }) => {
    const deepest = [...targets].sort((x, y) => y.split("/").length - x.split("/").length)[0]!;
    return { kind: "cmd", at: a.at, a: { ...a, target: deepest }, more: targets.filter((t) => t !== deepest && !deepest.startsWith(t + "/")).length };
  });
  return [...cmds, ...changes.map((c): Row => ({ kind: "change", at: c.at, c }))].sort((x, y) => y.at - x.at);
}

export function ActivityList({ items, changes, onOpenTarget, compact, showTarget = true }: {
  items: ActivityDto[]; changes: ChangeDto[]; onOpenTarget?(target: string): void; compact?: boolean; showTarget?: boolean;
}) {
  const nav = useBbNavigate();
  const now = useNow();
  const rows = rowsOf(items, changes);
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">No agent activity recorded yet. Commands agents run against these hosts (ssh, pct, qm, pvesh) show up here.</p>;
  return (
    <ul className="divide-y">
      {rows.map((r, i) => (
        <li key={i} className={cn("flex gap-3 py-2", compact ? "text-xs" : "text-sm")}>
          <span className="w-10 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted-foreground" title={new Date(r.at).toLocaleString()}>{age(now - r.at)}</span>
          <div className="min-w-0 flex-1 space-y-0.5">
            {r.kind === "cmd" ? (
              <>
                <div className="flex min-w-0 items-center gap-2">
                  <button type="button" className="min-w-0 truncate font-medium hover:underline" onClick={() => nav.toThread(r.a.threadId)}><ThreadTitle threadId={r.a.threadId} /></button>
                  {showTarget ? <button type="button" className="shrink-0 font-mono text-xs text-muted-foreground hover:underline" onClick={() => onOpenTarget?.(r.a.target)}>{r.a.target}{r.more ? ` +${r.more}` : ""}</button> : null}
                  {r.a.phase === "started" ? <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">running</span> : r.a.exitCode ? <span className="shrink-0 text-xs text-destructive">exit {r.a.exitCode}</span> : null}
                </div>
                <code className="block truncate text-xs text-muted-foreground" title={r.a.command}>$ {r.a.command}</code>
              </>
            ) : (
              <div className="flex min-w-0 flex-wrap items-center gap-x-2">
                <button type="button" className="font-mono text-xs hover:underline" onClick={() => onOpenTarget?.(r.c.target)}>{r.c.target}</button>
                <span>{CHANGE_TEXT[r.c.kind]}{r.c.detail ? ` · ${r.c.detail}` : ""}</span>
                {r.c.threadId ? <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => nav.toThread(r.c.threadId!)}>likely by <ThreadTitle threadId={r.c.threadId} /></button> : null}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ActivityFeed({ envSlug, target, onOpenTarget, compact }: { envSlug?: string; target?: string; onOpenTarget?(target: string): void; compact?: boolean }) {
  const q = useInfraQuery("activity", { envSlug, target, limit: 100 }, { refreshOn: ["infra:activity", "infra:events"] });
  if (q.error) return <p className="text-sm text-destructive">{q.error}</p>;
  return <ActivityList items={q.data?.items ?? []} changes={q.data?.changes ?? []} onOpenTarget={onOpenTarget} compact={compact} />;
}
