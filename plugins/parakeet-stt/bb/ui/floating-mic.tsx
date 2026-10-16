import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { controller } from "../dictation.ts";
import { useDictationState, usePhoneLayout, usePrefs, usePress, useTargetCount } from "./hooks.ts";

/** Phone-only floating mic: dictate into the visible composer without opening the keyboard. */
export function FloatingMic() {
  const s = useDictationState();
  const targets = useTargetCount();
  const prefs = usePrefs();
  const phone = usePhoneLayout();
  const press = usePress();
  if (!prefs.floatingMic || !phone || targets === 0) return null;
  const live = s.phase === "recording" || s.phase === "streaming";
  const busy = s.phase === "transcribing" || s.phase === "finishing";
  const waiting = live && s.waiting;
  return (
    <button
      type="button"
      aria-label={waiting ? "Stop dictation (waiting for the start phrase)" : live ? "Stop dictation" : busy ? "Finishing…" : "Dictate — tap, or hold to talk"}
      aria-pressed={live}
      disabled={busy}
      onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); press.down(); }}
      onPointerUp={() => press.up()}
      onPointerCancel={() => press.cancel()}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => { if (e.detail === 0) void controller.toggle(); }}
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 7.5rem)" }}
      className={cn(
        "fixed right-4 z-50 flex size-14 touch-none select-none items-center justify-center rounded-full shadow-lg",
        waiting ? "bg-amber-500 text-white" : live ? "bg-red-500 text-white animate-pulse" : "bg-foreground text-background",
        busy && "opacity-60",
      )}
    >
      <Icon name="Mic" aria-hidden />
    </button>
  );
}
