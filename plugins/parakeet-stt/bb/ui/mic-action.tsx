import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { controller } from "../dictation.ts";
import { useComposerTarget, useControllerDeps, useDictationState, usePress } from "./hooks.ts";

export function MicAction() {
  useControllerDeps();
  const id = useComposerTarget();
  const s = useDictationState();
  const mine = s.targetId === id;
  const live = mine && (s.phase === "recording" || s.phase === "streaming");
  const busy = mine && (s.phase === "transcribing" || s.phase === "finishing");
  const waiting = live && s.waiting;
  const press = usePress(id);
  const label = waiting ? "Stop dictation (waiting for the start phrase)" : live ? "Stop dictation" : busy ? "Finishing…" : "Dictate — tap, or hold to talk";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-pressed={live}
      disabled={busy}
      // preventDefault keeps focus (and the phone keyboard) on the composer while pressing the mic
      onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); press.down(); }}
      onPointerUp={() => press.up()}
      onPointerCancel={() => press.cancel()}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => { if (e.detail === 0) void controller.toggle(id); }}
      className={cn("touch-none select-none", waiting ? "text-amber-500" : live ? "text-red-500 animate-pulse" : busy ? "opacity-60 animate-pulse" : undefined)}
    >
      <Icon name="Mic" aria-hidden />
    </Button>
  );
}
