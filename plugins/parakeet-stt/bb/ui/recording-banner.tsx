import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { controller } from "../dictation.ts";
import { dictationPrefs as prefsNow } from "../dictation-prefs.ts";
import { useComposerTarget, useControllerDeps, useDictationState, useSecondTick } from "./hooks.ts";

export function RecordingBanner() {
  useControllerDeps();
  const id = useComposerTarget();
  const s = useDictationState();
  const active = s.phase === "recording" || s.phase === "streaming";
  useSecondTick(active);
  if (s.targetId !== id || s.phase === "idle") return null;
  const secs = s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0;
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const heard = s.heard ? ` · heard “${s.heard.length > 40 ? `${s.heard.slice(0, 40)}…` : s.heard}”` : "";
  const label = s.phase === "streaming" && s.waiting ? `Waiting for “${prefsNow().startPhrases[0] ?? "start phrase"}”… ${elapsed}${heard}`
    : s.phase === "streaming" ? `Listening (continuous)… ${elapsed}`
    : s.phase === "recording" ? `Listening… ${elapsed}`
      : s.phase === "finishing" ? "Finishing…" : "Transcribing…";
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm" role="status" aria-live="polite">
      <span className={cn("size-2 rounded-full", s.waiting ? "bg-amber-500" : "bg-red-500 animate-pulse")} aria-hidden />
      <span className="flex-1">{label}</span>
      {active && (
        <>
          <Button size="sm" onClick={() => void controller.stop()}>Stop</Button>
          <Button size="sm" variant="ghost" onClick={() => controller.cancel()}>Cancel</Button>
        </>
      )}
    </div>
  );
}
