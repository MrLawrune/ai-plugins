import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useControls, useStatus } from "./state.ts";
import { statusLine } from "./status.ts";
import { StatusDot } from "./ui.tsx";

export function KokoroHeader() {
  const status = useStatus();
  const { setMuted, stopAll } = useControls();
  const line = statusLine(status);
  const up = status?.health.up === true;
  const muted = status?.health.up === true && status.health.health.muted === true;
  return (
    <div className="flex items-center gap-1.5">
      <span className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex" role="status">
        <StatusDot tone={line.tone} />
        {line.text}
      </span>
      <Button variant="ghost" size="sm" disabled={!up} onClick={() => void stopAll()}>
        <Icon name="Square" className="size-3.5" />
        Stop
      </Button>
      <Button variant={muted ? "default" : "ghost"} size="sm" disabled={!up} aria-pressed={muted}
        onClick={() => void setMuted(!muted)}>
        <Icon name={muted ? "Mic" : "Pause"} className="size-3.5" />
        {muted ? "Unmute" : "Mute"}
      </Button>
    </div>
  );
}
