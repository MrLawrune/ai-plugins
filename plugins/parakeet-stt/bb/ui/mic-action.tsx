import { useEffect, useRef } from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { controller } from "../dictation.ts";
import { followBottom } from "../follow-bottom.ts";
import { useComposerTarget, useControllerDeps, useDictationState, usePrefs, usePress } from "./hooks.ts";

const EDITOR_RETRIES = 10;

export function MicAction() {
  useControllerDeps();
  const id = useComposerTarget();
  const s = useDictationState();
  const mine = s.targetId === id;
  const live = mine && (s.phase === "recording" || s.phase === "streaming");
  const busy = mine && (s.phase === "transcribing" || s.phase === "finishing");
  const waiting = live && s.waiting;
  const press = usePress(id);
  const { layout, key } = useComposer();
  const { expandCompactDraft } = usePrefs();
  const ref = useRef<HTMLButtonElement>(null);
  // bb's collapsed composer wraps the draft (see compact-draft); keep this composer's newest words in view.
  // The editor is looked up again for a different composer key, and for a few frames if it is not mounted yet.
  useEffect(() => {
    if (layout !== "compact" || !expandCompactDraft) return;
    const stop = new AbortController();
    let frame = 0;
    let tries = 0;
    const attach = () => {
      const editor = ref.current?.closest("form[data-promptbox]")?.querySelector<HTMLElement>("[data-promptbox-compact-content] .ProseMirror");
      if (editor) followBottom(editor, stop.signal);
      else if (++tries < EDITOR_RETRIES) frame = requestAnimationFrame(attach);
    };
    attach();
    return () => {
      cancelAnimationFrame(frame);
      stop.abort();
    };
  }, [layout, key, expandCompactDraft]);
  const label = waiting ? "Stop dictation (waiting for the start phrase)" : live ? "Stop dictation" : busy ? "Finishing…" : "Dictate — tap, or hold to talk";
  return (
    <Button
      ref={ref}
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
