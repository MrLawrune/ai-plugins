// Proxmox task rows: BB-started tasks are marked; any row opens its log; running BB tasks can be stopped.
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ActionDto, TaskEntry } from "../schemas.ts";
import { isOpen } from "./actions-model.ts";
import { age } from "./format.ts";
import { useInfraRpc, useNow } from "./hooks.ts";
import { TaskLogDialog } from "./task-log.tsx";

export function TaskList({ tasks, target, tracked = [] }: { tasks: TaskEntry[]; target?: string; tracked?: ActionDto[] }) {
  const now = useNow();
  const call = useInfraRpc();
  const [log, setLog] = useState<TaskEntry | null>(null);
  const [abortFor, setAbortFor] = useState<ActionDto | null>(null);
  const byUpid = new Map(tracked.filter((a) => a.upid).map((a) => [a.upid!, a]));
  if (!tasks.length) return <p className="py-4 text-center text-sm text-muted-foreground">No recent Proxmox tasks.</p>;
  return (
    <>
      <ul className="divide-y text-sm">
        {tasks.map((t) => {
          const mine = byUpid.get(t.upid);
          return (
            <li key={t.upid} className="flex items-center gap-3 py-1.5">
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{age(now - t.start * 1000)}</span>
              <button type="button" className="font-mono text-xs hover:underline" disabled={!target} onClick={() => setLog(t)}>{t.type}{t.id ? ` ${t.id}` : ""}</button>
              <span className="truncate text-xs text-muted-foreground">{mine ? `you · ${mine.sourceSurface === "thread-panel" ? "thread panel" : "Infra page"}` : t.user}</span>
              {mine && isOpen(mine) ? <Button size="sm" variant="ghost" className="ml-auto h-6 text-xs" onClick={() => setAbortFor(mine)}>Stop task</Button> : null}
              <span className={t.status === "OK" ? "ml-auto text-xs text-muted-foreground" : t.status === null ? "ml-auto text-xs text-emerald-600 dark:text-emerald-400" : "ml-auto text-xs text-destructive"}>{t.status ?? "running"}</span>
            </li>
          );
        })}
      </ul>
      {log && target ? <TaskLogDialog target={target} upid={log.upid} title={`${log.type}${log.id ? ` ${log.id}` : ""}`} onClose={() => setLog(null)} /> : null}
      {abortFor ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) setAbortFor(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Stop this task?</AlertDialogTitle>
              <AlertDialogDescription>Proxmox interrupts the running {abortFor.action} on {abortFor.guestName || abortFor.target}. The guest may be left partway through the change.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep running</AlertDialogCancel>
              <AlertDialogAction onClick={() => { const id = abortFor.id; setAbortFor(null); void call("actionAbort", { actionId: id }).then((r) => { if (!r.ok) toast.error(r.reason); }, (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))); }}>Stop task</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
