// React glue for the composer surfaces. Subscribe functions live at module level so
// useSyncExternalStore never resubscribes on re-render; the phone MediaQueryList is shared.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { dictationPrefs as prefsNow, onDictationPrefs, setDictationPrefs } from "../dictation-prefs.ts";
import { controller, type DictationDeps } from "../dictation.ts";
import { thisDevice } from "../device.ts";
import { createPressDetector } from "../press.ts";
import { blobToBase64, extensionFor, startBrowserRecording } from "../recorder.ts";
import type { rpcContract } from "../contract.ts";
import type { Prefs, SoundName } from "../schemas.ts";
import { startBrowserStream } from "../stream-client.ts";
import { makeTarget, toastNotify } from "./target.ts";

export const PLUGIN_BASE = "/api/v1/plugins/parakeet-stt/http";
const HOLD_MS = 350;
const PHONE_QUERY = "(pointer: coarse), (max-width: 640px)";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

let hello: Promise<void> | null = null;

/** One `hello` per page load, shared by every composer surface; a failed one is retried by the next mount. */
export function ensureHello(rpc: Rpc): Promise<void> {
  hello ??= (async () => {
    const me = thisDevice();
    const r = await rpc.call("hello", { deviceId: me.id, name: me.name, kind: me.kind });
    setDictationPrefs(r.prefs);
  })().catch(() => { hello = null; });
  return hello;
}

let configured = false;

function configureController(rpc: Rpc): void {
  if (configured) return;
  configured = true;
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
      return startBrowserStream(`${proto}://${location.host}${PLUGIN_BASE}/stream`, h, onInterrupt, () => prefsNow().keepListeningHidden, thisDevice().id);
    },
    prefs: prefsNow,
    playSound: (name: SoundName) => { void new Audio(`${PLUGIN_BASE}/sound/${name}`).play().catch(() => undefined); },
    notify: (kind, message) => { if (kind === "error") toast.error(message); else toast(message); },
    now: Date.now,
  };
  controller.configure(deps);
}

/** Configures the shared controller (and says hello) once per page load, from the first composer surface. */
export function useControllerDeps(): void {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    configureController(rpc);
    void ensureHello(rpc);
  }, [rpc]);
}

const subscribeController = (l: () => void) => controller.subscribe(l);
const dictationSnapshot = () => controller.snapshot();
const targetCountSnapshot = () => controller.targetCount();
const subscribePrefs = (l: () => void) => onDictationPrefs(() => l());

export const useDictationState = () => useSyncExternalStore(subscribeController, dictationSnapshot);
export const useTargetCount = () => useSyncExternalStore(subscribeController, targetCountSnapshot);
export const usePrefs = (): Prefs => useSyncExternalStore(subscribePrefs, prefsNow);

let phoneQuery: MediaQueryList | null = null;
const phone = () => (phoneQuery ??= matchMedia(PHONE_QUERY));
const subscribePhone = (l: () => void) => {
  const m = phone();
  m.addEventListener("change", l);
  return () => m.removeEventListener("change", l);
};
const phoneSnapshot = () => phone().matches;

export const usePhoneLayout = (): boolean => useSyncExternalStore(subscribePhone, phoneSnapshot);

/** Registers the composer that mounted this component as a dictation target; returns its key. */
export function useComposerTarget(): string {
  const composer = useComposer();
  const key = composer.key;
  const ref = useRef(composer);
  ref.current = composer;
  useEffect(() => controller.register(makeTarget(key, () => ref.current, toastNotify)), [key]);
  return key;
}

/** Re-renders once a second while `active`, for the elapsed-time readout. */
export function useSecondTick(active: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

/** Tap = default mode, hold = one-shot push-to-talk. `id` undefined targets the latest composer. */
export function usePress(id?: string) {
  return useMemo(() => createPressDetector({
    holdMs: HOLD_MS,
    onTap: () => void controller.toggle(id),
    onHoldStart: () => void controller.start(id, "oneshot"),
    onHoldEnd: () => void controller.stop(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }), [id]);
}
