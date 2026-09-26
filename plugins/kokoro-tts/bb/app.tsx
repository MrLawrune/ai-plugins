// bb-plugin-kokoro-tts — frontend entry: the "Kokoro TTS" sidebar panel and the chat chip content script.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountPlayer } from "./player/script.ts";
import { KokoroPanel } from "./page/panel.tsx";
import type { IconSvgElement } from "@hugeicons/react";
import {
  CancelCircleIcon,
  SpeechIcon,
  StopCircleIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
} from "@hugeicons/core-free-icons";

// ---------------------------------------------------------------------------
// Chat: render the voice contract's HTML-comment block as a compact summary
// ---------------------------------------------------------------------------

const TTS_BLOCK = /<!--\s*TTS_RESPONSE\s+weight="([^"]+)"\s*(?:\n([\s\S]*?)\nTTS_RESPONSE\s*)?-->/g;
const TTS_MARK = "data-kokoro-tts";
const CHIP_CLASS = "kokoro-tts-chip";
/** How long a speech chip waits for the hook to report before showing "not spoken". */
const PENDING_GRACE_MS = 25_000;
/** Chips rendered this soon after mount are history, not live turns. */
const HISTORY_WINDOW_MS = 4_000;
let mountedAt = 0;

type ChipState = "pending" | "unknown" | "spoken" | "playing" | "interrupted" | "unspoken" | "error" | "muted" | "sound" | "silent";

const CHIP_ICON: Record<ChipState, IconSvgElement> = {
  pending: SpeechIcon,
  unknown: SpeechIcon,
  spoken: SpeechIcon,
  playing: SpeechIcon,
  interrupted: StopCircleIcon,
  unspoken: CancelCircleIcon,
  error: CancelCircleIcon,
  muted: VolumeMute01Icon,
  sound: VolumeHighIcon,
  silent: VolumeMute01Icon,
};

const CHIP_TITLE: Record<ChipState, string> = {
  pending: "Waiting for the voice hook",
  unknown: "No playback record (older than the speech log)",
  spoken: "Spoken",
  playing: "Speaking now",
  interrupted: "Speech was interrupted",
  unspoken: "Not spoken (no record from the voice hook)",
  error: "Speech failed",
  muted: "Muted when this was sent",
  sound: "Sound cue",
  silent: "Silent turn",
};

/** Render a hugeicons definition to an inline SVG string (no React in the content script). */
function iconSvg(def: IconSvgElement): string {
  const body = def
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${String(v)}"`)
        .join(" ");
      return `<${tag} ${a}/>`;
    })
    .join("");
  return `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true">${body}</svg>`;
}

const ICON_SVG = Object.fromEntries(
  Object.entries(CHIP_ICON).map(([k, v]) => [k, iconSvg(v)]),
) as Record<ChipState, string>;

function normText(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

function setChipState(chip: HTMLElement, state: ChipState, detail?: string) {
  if (chip.dataset.kokoroState === state && chip.dataset.kokoroDetail === (detail ?? "")) return;
  chip.dataset.kokoroState = state;
  chip.dataset.kokoroDetail = detail ?? "";
  const icon = chip.querySelector(".kokoro-tts-icon");
  if (icon) icon.innerHTML = ICON_SVG[state];
  chip.title = detail ? `${CHIP_TITLE[state]} — ${detail}` : CHIP_TITLE[state];
}

function initialState(weight: string): ChipState {
  if (weight === "speech") return "pending";
  if (weight === "silent") return "silent";
  return "sound";
}

function makeChip(weight: string, label: string): HTMLElement {
  const chip = document.createElement("span");
  chip.setAttribute(TTS_MARK, weight);
  chip.setAttribute("data-kokoro-label", label);
  chip.dataset.kokoroSeen = String(Date.now());
  // Chips that appear while the page is still rendering history were not
  // spoken in this session; a missing log entry means "unknown", not "failed".
  if (Date.now() - mountedAt < HISTORY_WINDOW_MS) chip.dataset.kokoroHistoric = "1";
  chip.className = CHIP_CLASS;
  const icon = document.createElement("span");
  icon.className = "kokoro-tts-icon";
  chip.appendChild(icon);
  chip.appendChild(document.createTextNode(label));
  setChipState(chip, initialState(weight));
  return chip;
}

/** Replace raw TTS_RESPONSE comment text with chips. Returns true if any speech chip was added. */
function summarizeTtsBlocks(root: ParentNode): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Text).data.includes("TTS_RESPONSE")) hits.push(n as Text);
  }
  let addedSpeech = false;
  for (const node of hits) {
    const el = node.parentElement;
    if (!el || el.closest(`[${TTS_MARK}]`) || el.closest("pre, code, textarea, input")) continue;
    const text = node.data;
    const blocks: { weight: string; label: string }[] = [];
    const stripped = text.replace(TTS_BLOCK, (_m, weight: string, spoken?: string) => {
      const said = (spoken ?? "").trim();
      const label = said || (weight === "silent" ? "silent" : weight.replace("sound:", "sound: "));
      blocks.push({ weight, label });
      return "";
    });
    if (blocks.length === 0) continue;
    // Mutate the text node in place instead of replacing it: React keeps a
    // reference to this node and re-renders would otherwise re-insert the raw
    // block next to a chip we already added (duplicate chips).
    if (stripped !== text) node.data = stripped;
    const existing = Array.from(el.querySelectorAll<HTMLElement>(`:scope > span[${TTS_MARK}]`));
    let anchor: Node = node;
    for (const b of blocks) {
      const dup = existing.find(
        (e) => e.getAttribute(TTS_MARK) === b.weight && e.getAttribute("data-kokoro-label") === b.label,
      );
      if (dup) {
        anchor = dup;
        continue;
      }
      const chip = makeChip(b.weight, b.label);
      (anchor as ChildNode).after(chip);
      existing.push(chip);
      anchor = chip;
      if (b.weight === "speech") addedSpeech = true;
    }
  }
  return addedSpeech;
}

type LogEntry = { text: string; status: string; error?: string; first_audio_ms?: number; ts: number };

function stateFromEntry(e: LogEntry): [ChipState, string | undefined] {
  switch (e.status) {
    case "done":
      return ["spoken", e.first_audio_ms != null ? `${e.first_audio_ms} ms to first audio` : undefined];
    case "queued":
    case "playing":
      return ["playing", undefined];
    case "interrupted":
      return ["interrupted", undefined];
    case "error":
      return ["error", e.error];
    case "muted":
      return ["muted", undefined];
    case "empty":
      return ["error", "nothing left to speak after stripping markup"];
    default:
      return ["pending", undefined];
  }
}

/**
 * Apply speech-log entries to speech chips. Matching is by normalized spoken
 * text (what the hook sends is the block content). Returns true while any chip
 * still needs a later refresh (pending inside the grace window, or playing).
 */
function applySpeechLog(entries: LogEntry[]): boolean {
  const byText = new Map<string, LogEntry>();
  for (const e of entries) byText.set(e.text, e); // later entries win
  const now = Date.now();
  let needsRefresh = false;
  for (const chip of Array.from(document.querySelectorAll<HTMLElement>(`span.${CHIP_CLASS}[${TTS_MARK}="speech"]`))) {
    const label = chip.getAttribute("data-kokoro-label") ?? "";
    const hit = byText.get(normText(label));
    if (hit) {
      const [state, detail] = stateFromEntry(hit);
      setChipState(chip, state, detail);
      if (state === "playing") needsRefresh = true;
      continue;
    }
    const seen = Number(chip.dataset.kokoroSeen ?? now);
    if (now - seen < PENDING_GRACE_MS) {
      setChipState(chip, "pending");
      needsRefresh = true;
    } else {
      setChipState(chip, chip.dataset.kokoroHistoric ? "unknown" : "unspoken");
    }
  }
  return needsRefresh;
}

async function fetchSpeechLog(pluginId: string, signal: AbortSignal): Promise<LogEntry[] | null> {
  try {
    const res = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/speechLog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok: boolean; result?: { entries: LogEntry[] } };
    return data.ok && data.result ? data.result.entries : null;
  } catch {
    return null;
  }
}

const CHIP_CSS = `
.${CHIP_CLASS}{display:inline-flex;gap:.4em;align-items:baseline;font-size:.8em;color:var(--muted-foreground,#888);border:1px solid var(--border,#3333);border-radius:.4em;padding:.05em .5em;margin-top:.25em;line-height:1.4}
.${CHIP_CLASS} .kokoro-tts-icon{display:inline-flex;align-self:center;font-size:1.15em;line-height:1}
.${CHIP_CLASS} .kokoro-tts-icon svg{display:block}
.${CHIP_CLASS}[data-kokoro-state="spoken"] .kokoro-tts-icon{color:var(--primary,#8ab4f8)}
.${CHIP_CLASS}[data-kokoro-state="playing"] .kokoro-tts-icon{color:var(--primary,#8ab4f8);animation:kokoro-pulse 1.2s ease-in-out infinite}
.${CHIP_CLASS}[data-kokoro-state="pending"] .kokoro-tts-icon,
.${CHIP_CLASS}[data-kokoro-state="unknown"] .kokoro-tts-icon{opacity:.45}
.${CHIP_CLASS}[data-kokoro-state="unspoken"] .kokoro-tts-icon,
.${CHIP_CLASS}[data-kokoro-state="error"] .kokoro-tts-icon{color:var(--destructive,#e5484d)}
.${CHIP_CLASS}[data-kokoro-state="interrupted"] .kokoro-tts-icon{color:var(--warning,#e0a526)}
@keyframes kokoro-pulse{0%,100%{opacity:1}50%{opacity:.35}}
`;

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "player",
    mount: ({ pluginId, signal }) => mountPlayer({ pluginId, signal }),
  });

  app.contentScripts.register({
    id: "tts-block-summary",
    mount({ signal, pluginId }) {
      mountedAt = Date.now();
      const style = document.createElement("style");
      style.textContent = CHIP_CSS;
      document.head.appendChild(style);

      let scheduled = false;
      let refreshTimer: ReturnType<typeof setTimeout> | null = null;
      let refreshing = false;
      let lastFetch = 0;

      const scheduleRefresh = (delay: number) => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refresh(), delay);
      };
      const refresh = async () => {
        if (signal.aborted || refreshing) return;
        if (!document.querySelector(`span.${CHIP_CLASS}[${TTS_MARK}="speech"]`)) return;
        refreshing = true;
        lastFetch = Date.now();
        const entries = await fetchSpeechLog(pluginId, signal);
        refreshing = false;
        if (signal.aborted) return;
        const again = entries ? applySpeechLog(entries) : true;
        if (again) scheduleRefresh(entries ? 2500 : 8000);
      };

      const run = () => {
        scheduled = false;
        const added = summarizeTtsBlocks(document.body);
        if (added) scheduleRefresh(Math.max(0, 1500 - (Date.now() - lastFetch)));
      };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(run);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      schedule();
      const onVisible = () => {
        if (document.visibilityState === "visible") scheduleRefresh(0);
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        observer.disconnect();
        if (refreshTimer) clearTimeout(refreshTimer);
        document.removeEventListener("visibilitychange", onVisible);
        style.remove();
        document.querySelectorAll(`.${CHIP_CLASS}`).forEach((c) => c.remove());
      };
    },
  });

  app.slots.navPanel({
    id: "kokoro-tts",
    title: "Kokoro TTS",
    icon: "Mic",
    path: "kokoro",
    component: KokoroPanel,
  });
});
