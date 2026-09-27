// Thread header chip: ▶ n for runs started from this thread that are still running; opens the panel.
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { CHANNELS } from "../shared/constants.ts";
import { usePlaybooksQuery } from "./hooks.ts";
import { useOpenPanel } from "./panel-open.ts";

const LIVE = new Set(["queued", "starting", "running"]);

export function HeaderChip({ threadId }: PluginThreadHeaderActionProps) {
  const q = usePlaybooksQuery("runs.list", { threadId, limit: 50 }, { refreshOn: [CHANNELS.run] });
  const openPanel = useOpenPanel();
  const running = q.data?.runs.filter((r) => LIVE.has(r.status)) ?? [];
  if (!running.length) return null;
  return (
    <Button variant="ghost" size="sm" aria-label={`${running.length} playbook run${running.length === 1 ? "" : "s"} running`} onClick={() => openPanel({ runId: running[0]!.id }, "Run")}>
      ▶ {running.length}
    </Button>
  );
}
