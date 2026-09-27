// L2 block: one step's details plus the dispatch actions. Shared by the list view and the graph view.
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { TaskSummary } from "../shared/types.ts";
import type { ListDispatch } from "./playbook-list.tsx";

function Detail({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 flex-1 break-words font-mono">{children}</span>
    </div>
  );
}

export function DispatchActions({ target, label, dispatch }: { target: string; label?: string; dispatch: ListDispatch }) {
  return (
    <div className="flex gap-1 pt-1">
      <Button variant="outline" size="sm" onClick={() => dispatch.onAddToChat(target, label)}>Add to chat</Button>
      <Button variant="outline" size="sm" onClick={() => dispatch.onNewThread(target, label)}>New thread…</Button>
    </div>
  );
}

export function L2Block({ t, target, dispatch, playBecome }: { t: TaskSummary; target: string; dispatch: ListDispatch; playBecome: boolean | null }) {
  const become = t.become ?? playBecome;
  return (
    <div className="mb-1 space-y-0.5 rounded-md border bg-card px-2 py-1.5">
      <Detail k="module">{t.action}</Detail>
      {t.args.map((a) => <Detail key={a.key} k={a.key}>{a.value}</Detail>)}
      {t.when ? <Detail k="when">{t.when}</Detail> : null}
      {t.loop ? <Detail k="loop">{t.loop}</Detail> : null}
      {t.register ? <Detail k="register">{t.register}</Detail> : null}
      {t.notify.length ? <Detail k="notify">{t.notify.join(", ")}</Detail> : null}
      {t.tags.length ? <Detail k="tags">{t.tags.join(", ")}</Detail> : null}
      {become !== null ? <Detail k="become">{become ? "yes" : "no"}{t.become === null ? " (play)" : ""}</Detail> : null}
      {t.delegateTo ? <Detail k="delegate">{t.delegateTo}</Detail> : null}
      <DispatchActions target={target} label={t.plain} dispatch={dispatch} />
    </div>
  );
}
