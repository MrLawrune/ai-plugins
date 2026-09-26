// Proxmox task log rows.
import type { TaskEntry } from "../schemas.ts";
import { age } from "./format.ts";
import { useNow } from "./hooks.ts";

export function TaskList({ tasks }: { tasks: TaskEntry[] }) {
  const now = useNow();
  if (!tasks.length) return <p className="py-4 text-center text-sm text-muted-foreground">No recent Proxmox tasks.</p>;
  return (
    <ul className="divide-y text-sm">
      {tasks.map((t) => (
        <li key={t.upid} className="flex items-center gap-3 py-1.5">
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{age(now - t.start * 1000)}</span>
          <span className="font-mono text-xs">{t.type}{t.id ? ` ${t.id}` : ""}</span>
          <span className="truncate text-xs text-muted-foreground">{t.user}</span>
          <span className={t.status === "OK" ? "ml-auto text-xs text-muted-foreground" : t.status === null ? "ml-auto text-xs text-emerald-600 dark:text-emerald-400" : "ml-auto text-xs text-destructive"}>{t.status ?? "running"}</span>
        </li>
      ))}
    </ul>
  );
}
