// Bodies of the plugin's content scripts: each mounts into the bb page and undoes itself on `signal`.
import { matchesShortcut, controller } from "../dictation.ts";
import { dictationPrefs as prefsNow, onDictationPrefs, setDictationPrefs } from "../dictation-prefs.ts";
import { trackCaret } from "../caret-tracker.ts";
import { thisDevice } from "../device.ts";
import type { Prefs } from "../schemas.ts";
import { PLUGIN_BASE } from "./constants.ts";

export function mountCaret(signal: AbortSignal): void {
  trackCaret(signal);
}

export function mountShortcuts(signal: AbortSignal): void {
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
}

export function mountCompactDraft(signal: AbortSignal): void {
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
  signal.addEventListener("abort", () => { off(); style.remove(); });
}

export function mountNativeMic(signal: AbortSignal): void {
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
  void fetch(`${PLUGIN_BASE}/prefs?device=${encodeURIComponent(thisDevice().id)}`, { signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((p: Prefs | null) => { if (p) setDictationPrefs(p); })
    .catch(() => undefined);
  signal.addEventListener("abort", () => { off(); style.remove(); });
}
