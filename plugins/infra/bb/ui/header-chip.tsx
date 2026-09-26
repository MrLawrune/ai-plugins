// Thread header chip: how many infra targets this thread touched, with a popover to jump to them.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EnvBadge, StateDot } from "./badges.tsx";
import { useInfraQuery } from "./hooks.ts";
import { InfraIcon } from "./icons.tsx";
import { PANEL_ACTION_ID } from "./thread-panel.tsx";

export function HeaderChip({ threadId }: { threadId: string }) {
  const q = useInfraQuery("threadTargets", { threadId }, { refreshOn: ["infra:activity", "infra:changed"] });
  const nav = useBbNavigate();
  const [open, setOpen] = useState(false);
  const targets = q.data?.targets ?? [];
  if (!targets.length) return null;
  const running = targets.some((t) => t.running);
  const show = (target: string | null, title: string) => {
    setOpen(false);
    nav.openThreadPanel({ actionId: PANEL_ACTION_ID, title, ...(target ? { params: { target } } : {}) });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" aria-label={`Infra: ${targets.length} targets touched by this thread`}>
          <InfraIcon name="infra" className="size-4" />
          <span className="tabular-nums">{targets.length}</span>
          {running ? <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <p className="px-1 pb-1 text-xs text-muted-foreground">Infrastructure this thread worked on</p>
        <ul className="space-y-0.5">
          {targets.map((t) => (
            <li key={t.target}>
              <button type="button" onClick={() => show(t.target, t.label)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-state-hover">
                {t.state ? <StateDot state={t.state as "running"} active={t.running} /> : null}
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                <EnvBadge env={t.env} />
              </button>
            </li>
          ))}
        </ul>
        <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => show(null, "Infra")}>Open Infra panel</Button>
      </PopoverContent>
    </Popover>
  );
}
