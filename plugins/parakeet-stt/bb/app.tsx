// bb-plugin-parakeet-stt -- frontend: composer dictation (continuous + one-shot), shortcuts, settings page.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useComposer, useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { appendDictation, controller, matchesShortcut, type DictationDeps, type Target } from "./dictation.ts";
import { dictationPrefs as prefsNow, onDictationPrefs, setDictationPrefs } from "./dictation-prefs.ts";
import { applyLive, liveState, tailRange } from "./draft-tail.ts";
import { ParakeetPage } from "./page/parakeet-page.tsx";
import { followBottom } from "./follow-bottom.ts";
import { createPressDetector } from "./press.ts";
import { blobToBase64, extensionFor, startBrowserRecording } from "./recorder.ts";
import type { Prefs, rpcContract, SoundName } from "./schemas.ts";
import { startBrowserStream } from "./stream-client.ts";

const PLUGIN_ID = "parakeet-stt";
const PLUGIN_BASE = `/api/v1/plugins/${PLUGIN_ID}/http`;
const HOLD_MS = 350;

type ComposerApi = ReturnType<typeof useComposer>;

function useDictationState() {
  return useSyncExternalStore((l) => controller.subscribe(l), () => controller.snapshot());
}

/** Configures the shared controller with this app's RPC once any composer surface mounts. */
function useControllerDeps() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    void rpc.call("getPrefs").then(setDictationPrefs, () => undefined);
    let recordingMime = "audio/webm";
    const deps: DictationDeps = {
      startRecording: async (onInterrupt) => {
        const handle = await startBrowserRecording(onInterrupt, () => prefsNow().keepListeningHidden);
        recordingMime = handle.mimeType;
        return handle;
      },
      transcribe: async (blob) => {
        const { text } = await rpc.call("transcribe", {
          audioBase64: await blobToBase64(blob),
          mimeType: recordingMime,
          filename: `dictation.${extensionFor(recordingMime)}`,
        });
        return text;
      },
      startStream: (h, onInterrupt) => {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        return startBrowserStream(`${proto}://${location.host}${PLUGIN_BASE}/stream`, h, onInterrupt, () => prefsNow().keepListeningHidden);
      },
      prefs: prefsNow,
      playSound: (name: SoundName) => { void new Audio(`${PLUGIN_BASE}/sound/${name}`).play().catch(() => undefined); },
      notify: (kind, message) => { if (kind === "error") toast.error(message); else toast(message); },
      now: Date.now,
    };
    controller.configure(deps);
  }, [rpc]);
}

/** A dictation target bound to one composer; the live tail is shared (one session at a time). */
function makeTarget(id: string, composer: () => ComposerApi): Target {
  return {
    id,
    appendText: (text) => composer().updateText((current) => appendDictation(current, text, prefsNow().trailingSpace)),
    submit: () => { void composer().experimental_submit({ experimental_data: {} }); },
    setLive: (text, seq) => composer().updateText((d) => {
      const r = applyLive(d, liveState.get(), seq, text, false);
      liveState.set(r.state);
      return r.draft;
    }),
    commitLive: (text, seq) => composer().updateText((d) => {
      const r = applyLive(d, liveState.get(), seq, text, true);
      liveState.set(r.state);
      return r.draft;
    }),
  };
}

/** Registers the composer that mounted this component as a dictation target; returns its id. */
function useComposerTarget(): string {
  const composer = useComposer();
  const view = useComposerView();
  const id = JSON.stringify(view.scope);
  const ref = useRef(composer);
  ref.current = composer;
  useEffect(() => controller.register(makeTarget(id, () => ref.current)), [id]);
  return id;
}

/** Re-renders once a second while `active`, for the elapsed-time readout. */
function useSecondTick(active: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

/** Tap = default mode, hold = one-shot push-to-talk. `id` undefined targets the latest composer. */
function usePress(id?: string) {
  return useMemo(() => createPressDetector({
    holdMs: HOLD_MS,
    onTap: () => void controller.toggle(id),
    onHoldStart: () => void controller.start(id, "oneshot"),
    onHoldEnd: () => void controller.stop(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }), [id]);
}

function MicAction() {
  useControllerDeps();
  const id = useComposerTarget();
  const s = useDictationState();
  const mine = s.targetId === id;
  const live = mine && (s.phase === "recording" || s.phase === "streaming");
  const busy = mine && (s.phase === "transcribing" || s.phase === "finishing");
  const press = usePress(id);
  const label = live ? "Stop dictation" : busy ? "Finishing…" : "Dictate — tap, or hold to talk";
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
      className={cn("touch-none select-none", live ? "text-red-500 animate-pulse" : busy ? "opacity-60 animate-pulse" : undefined)}
    >
      <Icon name="Mic" aria-hidden />
    </Button>
  );
}

const PHONE_QUERY = "(pointer: coarse), (max-width: 640px)";

function usePhoneLayout(): boolean {
  return useSyncExternalStore(
    (l) => { const m = matchMedia(PHONE_QUERY); m.addEventListener("change", l); return () => m.removeEventListener("change", l); },
    () => matchMedia(PHONE_QUERY).matches,
  );
}

function usePrefs(): Prefs {
  return useSyncExternalStore((l) => onDictationPrefs(() => l()), prefsNow);
}

/** Phone-only floating mic: dictate into the visible composer without opening the keyboard. */
function FloatingMic() {
  const s = useDictationState();
  const targets = useSyncExternalStore((l) => controller.subscribe(l), () => controller.targetCount());
  const prefs = usePrefs();
  const phone = usePhoneLayout();
  const press = usePress();
  if (!prefs.floatingMic || !phone || targets === 0) return null;
  const live = s.phase === "recording" || s.phase === "streaming";
  const busy = s.phase === "transcribing" || s.phase === "finishing";
  return (
    <button
      type="button"
      aria-label={live ? "Stop dictation" : busy ? "Finishing…" : "Dictate — tap, or hold to talk"}
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
        live ? "bg-red-500 text-white animate-pulse" : "bg-foreground text-background",
        busy && "opacity-60",
      )}
    >
      <Icon name="Mic" aria-hidden />
    </button>
  );
}

function RecordingBanner() {
  useControllerDeps();
  const id = useComposerTarget();
  const s = useDictationState();
  const active = s.phase === "recording" || s.phase === "streaming";
  useSecondTick(active);
  if (s.targetId !== id || s.phase === "idle") return null;
  const secs = s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0;
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const label = s.phase === "streaming" ? `Listening (continuous)… ${elapsed}`
    : s.phase === "recording" ? `Listening… ${elapsed}`
      : s.phase === "finishing" ? "Finishing…" : "Transcribing…";
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm" role="status" aria-live="polite">
      <span className="size-2 rounded-full bg-red-500 animate-pulse" aria-hidden />
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

export default definePluginApp((app) => {
  app.composer.customize({
    id: "dictation",
    actions: [{ id: "mic", component: MicAction }],
    plusMenu: [{
      id: "dictate",
      label: "Dictate",
      icon: "Mic",
      description: "Speak instead of typing",
      disabled: () => controller.snapshot().phase !== "idle",
      run: ({ composer, view }) => {
        const id = JSON.stringify(view.scope);
        controller.register(makeTarget(id, () => composer));
        void controller.start(id);
      },
    }],
    banners: [{ id: "recording", component: RecordingBanner, chrome: "bare" }],
    richText: {
      effects: [{
        id: "live-tail",
        className: "opacity-50",
        match: (text) => {
          const r = tailRange(text, liveState.get().tail);
          return r ? [r] : [];
        },
      }],
    },
  });

  app.contentScripts.register({
    id: "shortcuts",
    mount({ signal }) {
      const onKeyDown = (e: KeyboardEvent) => {
        const phase = controller.snapshot().phase;
        if (e.key === "Escape" && (phase === "recording" || phase === "streaming")) {
          e.preventDefault();
          e.stopPropagation();
          controller.cancel();
          return;
        }
        if (!matchesShortcut(e, prefsNow().shortcut)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (prefsNow().holdToTalk) void controller.start(undefined, "oneshot");
        else void controller.toggle();
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (prefsNow().holdToTalk && e.code === "Space" && controller.snapshot().phase === "recording") void controller.stop();
      };
      document.addEventListener("keydown", onKeyDown, { capture: true, signal });
      document.addEventListener("keyup", onKeyUp, { capture: true, signal });
    },
  });

  app.contentScripts.register({
    id: "compact-draft",
    mount({ signal }) {
      // bb's collapsed (phone) composer clips the draft to one line with an ellipsis; let it wrap
      // up to ~4 lines and scroll beyond that. Unmatched selectors after a bb update simply do nothing.
      const style = document.createElement("style");
      style.textContent = [
        ":root [data-promptbox-compact] [data-promptbox-main]{height:auto!important;min-height:3rem!important}",
        ":root [data-promptbox-compact] [data-promptbox-editor-scroll]{height:auto!important;max-height:none!important;min-height:3rem!important}",
        ":root [data-promptbox-compact] [data-promptbox-editor-content]{height:auto!important;min-height:3rem!important;padding-block:0.5rem}",
        ":root [data-promptbox-compact-content] .ProseMirror[contenteditable]{white-space:pre-wrap!important;text-overflow:clip!important;max-height:6.8em!important;overflow-y:auto!important}",
        ":root [data-promptbox-compact-content] .ProseMirror[contenteditable] :where(p,li,blockquote,h1,h2,h3,h4,h5,h6){display:block!important}",
        ":root [data-promptbox-compact-content] .ProseMirror[contenteditable]>*+:before,:root [data-promptbox-compact-content] .ProseMirror[contenteditable] br:after{content:none!important}",
        ":root [data-promptbox-compact-content] .ProseMirror[contenteditable] br{display:initial!important}",
      ].join("\n");
      // Same cascade layer as bb's rule: layered !important beats unlayered, so specificity decides here.
      style.textContent = `@layer components {\n${style.textContent}\n}`;
      const apply = (p: Prefs = prefsNow()) => {
        if (p.expandCompactDraft) {
          if (!style.isConnected) document.head.appendChild(style);
        } else {
          style.remove();
        }
      };
      apply();
      const off = onDictationPrefs(apply);
      followBottom(document, "[data-promptbox-compact-content] .ProseMirror", signal);
      signal.addEventListener("abort", () => { off(); style.remove(); });
    },
  });

  app.contentScripts.register({
    id: "native-mic",
    mount({ signal }) {
      const style = document.createElement("style");
      style.textContent = 'button[aria-label$=" voice input"]{display:none !important}';
      const apply = (p: Prefs = prefsNow()) => {
        if (p.hideNativeMic) {
          if (!style.isConnected) document.head.appendChild(style);
        } else {
          style.remove();
        }
      };
      apply();
      const off = onDictationPrefs(apply);
      void fetch(`${PLUGIN_BASE}/prefs`, { signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((p: Prefs | null) => { if (p) setDictationPrefs(p); })
        .catch(() => undefined);
      signal.addEventListener("abort", () => { off(); style.remove(); });
    },
  });

  app.slots.experimental_appOverlay({ id: "floating-mic", component: FloatingMic });

  app.slots.navPanel({ id: "parakeet-stt", title: "Parakeet STT", icon: "Mic", path: "parakeet", component: ParakeetPage });
});
