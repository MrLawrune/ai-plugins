// bb-plugin-parakeet-stt -- frontend: composer dictation, shortcuts, settings page.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useComposer, useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { appendDictation, controller, matchesShortcut, type DictationDeps } from "./dictation.ts";
import { dictationPrefs as prefsNow, setDictationPrefs } from "./dictation-prefs.ts";
import { ParakeetPage } from "./page/parakeet-page.tsx";
import { blobToBase64, extensionFor, startBrowserRecording } from "./recorder.ts";
import type { rpcContract, SoundName } from "./schemas.ts";

const PLUGIN_ID = "parakeet-stt";

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
        const handle = await startBrowserRecording(onInterrupt);
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
      prefs: prefsNow,
      playSound: (name: SoundName) => { void new Audio(`/api/v1/plugins/${PLUGIN_ID}/http/sound/${name}`).play().catch(() => undefined); },
      notify: (kind, message) => { if (kind === "error") toast.error(message); else toast(message); },
      now: Date.now,
    };
    controller.configure(deps);
  }, [rpc]);
}

/** Registers the composer that mounted this component as a dictation target; returns its id. */
function useComposerTarget(): string {
  const composer = useComposer();
  const view = useComposerView();
  const id = JSON.stringify(view.scope);
  const ref = useRef(composer);
  ref.current = composer;
  useEffect(() => controller.register({
    id,
    appendText: (text) => ref.current.updateText((current) => appendDictation(current, text, prefsNow().trailingSpace)),
    submit: () => { void ref.current.experimental_submit({ experimental_data: {} }); },
  }), [id]);
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
  const recording = s.targetId === id && s.phase === "recording";
  const busy = s.targetId === id && s.phase === "transcribing";
  const label = recording ? "Stop dictation" : busy ? "Transcribing…" : "Dictate (Ctrl+Space)";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-pressed={recording}
      disabled={s.phase === "transcribing"}
      onClick={() => void controller.toggle(id)}
      className={recording ? "text-red-500 animate-pulse" : busy ? "opacity-60 animate-pulse" : undefined}
    >
      <Icon name="Mic" aria-hidden />
    </Button>
  );
}

function RecordingBanner() {
  useControllerDeps();
  const id = useComposerTarget();
  const s = useDictationState();
  useSecondTick(s.phase === "recording");
  if (s.targetId !== id || s.phase === "idle") return null;
  const secs = s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0;
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm" role="status" aria-live="polite">
      <span className="size-2 rounded-full bg-red-500 animate-pulse" aria-hidden />
      <span className="flex-1">{s.phase === "recording" ? `Listening… ${elapsed}` : "Transcribing…"}</span>
      {s.phase === "recording" && (
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
      disabled: () => controller.snapshot().phase === "transcribing",
      run: ({ composer, view }) => {
        const id = JSON.stringify(view.scope);
        controller.register({
          id,
          appendText: (text) => composer.updateText((current) => appendDictation(current, text, prefsNow().trailingSpace)),
          submit: () => { void composer.experimental_submit({ experimental_data: {} }); },
        });
        void controller.start(id);
      },
    }],
    banners: [{ id: "recording", component: RecordingBanner, chrome: "bare" }],
  });

  app.contentScripts.register({
    id: "shortcuts",
    mount({ signal }) {
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && controller.snapshot().phase === "recording") {
          e.preventDefault();
          e.stopPropagation();
          controller.cancel();
          return;
        }
        if (!matchesShortcut(e, prefsNow().shortcut)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (prefsNow().holdToTalk) void controller.start();
        else void controller.toggle();
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (prefsNow().holdToTalk && e.code === "Space" && controller.snapshot().phase === "recording") void controller.stop();
      };
      document.addEventListener("keydown", onKeyDown, { capture: true, signal });
      document.addEventListener("keyup", onKeyUp, { capture: true, signal });
    },
  });

  app.slots.navPanel({ id: "parakeet-stt", title: "Parakeet STT", icon: "Mic", path: "parakeet", component: ParakeetPage });
});
