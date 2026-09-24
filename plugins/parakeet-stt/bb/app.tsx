// bb-plugin-parakeet-stt -- frontend: composer dictation (continuous + one-shot), shortcuts, settings page.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useComposer, useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { appendDictation, controller, matchesShortcut, type DictationDeps, type Target } from "./dictation.ts";
import { dictationPrefs as prefsNow, onDictationPrefs, setDictationPrefs } from "./dictation-prefs.ts";
import { liveTail, replaceTail, tailRange } from "./draft-tail.ts";
import { ParakeetPage } from "./page/parakeet-page.tsx";
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
    setLive: (text) => composer().updateText((d) => {
      const r = replaceTail(d, liveTail.get(), text);
      liveTail.set(r.tail);
      return r.draft;
    }),
    commitLive: (text) => composer().updateText((d) => {
      const r = replaceTail(d, liveTail.get(), text);
      liveTail.set("");
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

function MicAction() {
  useControllerDeps();
  const id = useComposerTarget();
  const s = useDictationState();
  const mine = s.targetId === id;
  const live = mine && (s.phase === "recording" || s.phase === "streaming");
  const busy = mine && (s.phase === "transcribing" || s.phase === "finishing");
  const press = useMemo(() => createPressDetector({
    holdMs: HOLD_MS,
    onTap: () => void controller.toggle(id),
    onHoldStart: () => void controller.start(id, "oneshot"),
    onHoldEnd: () => void controller.stop(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }), [id]);
  const label = live ? "Stop dictation" : busy ? "Finishing…" : "Dictate — tap, or hold to talk";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-pressed={live}
      disabled={busy}
      onPointerDown={(e) => { if (e.button === 0) press.down(); }}
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
          const r = tailRange(text, liveTail.get());
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

  app.slots.navPanel({ id: "parakeet-stt", title: "Parakeet STT", icon: "Mic", path: "parakeet", component: ParakeetPage });
});
