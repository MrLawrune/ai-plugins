// Pure logic for the chat card: which speech-log entry belongs to a card and what its status line says.
import type { SpeechLogEntry } from "../schemas.ts";

/** The server stores at most this many characters of an entry's text. */
export const MAX_LOG_TEXT = 2000;
/** How long a card waits for its entry after its thread's turn before showing "Not spoken". */
export const PENDING_GRACE_MS = 25_000;
/**
 * A queued or playing entry older than this was orphaned (a lost status
 * report): read it as interrupted. Longer than the 15 minute hold for a
 * dropped window plus the longest full-mode reply.
 */
export const STALE_ENTRY_MS = 20 * 60_000;

export type CardState =
  | { kind: "queued" }
  | { kind: "playing" }
  | { kind: "spoken"; voice?: string; firstAudioMs?: number }
  | { kind: "interrupted" }
  | { kind: "muted" }
  | { kind: "off" }
  | { kind: "error"; detail: string }
  | { kind: "unspoken" }
  | { kind: "unknown" };

/** The server's text normalization: single spaces, capped like the log. */
export function normalizeSpoken(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_LOG_TEXT);
}

/** The newest entry in this thread whose text is this card's say. */
export function findEntry(entries: SpeechLogEntry[], threadId: string, say: string): SpeechLogEntry | undefined {
  const text = normalizeSpoken(say);
  let best: SpeechLogEntry | undefined;
  for (const e of entries) {
    if (e.session_id === threadId && e.text === text && (!best || e.id > best.id)) best = e;
  }
  return best;
}

/**
 * turnAt: when a turn in this card's thread logged this card's text.
 * pendingAt: when a turn went out for the thread while this was its newest card.
 * skipped: a turn for this card's reply made no log entry, because mute silenced
 * it ("muted"), the mode or a repeat did ("unspoken"), or the thread's voice is off ("off").
 */
export function cardState(
  entry: SpeechLogEntry | undefined,
  t: { turnAt: number | null; pendingAt?: number | null; skipped?: "muted" | "unspoken" | "off" | null; now: number },
): CardState {
  if (entry) {
    const stale = t.now - entry.ts * 1000 > STALE_ENTRY_MS;
    switch (entry.status) {
      case "queued": return stale ? { kind: "interrupted" } : { kind: "queued" };
      case "playing": return stale ? { kind: "interrupted" } : { kind: "playing" };
      case "done": return { kind: "spoken", voice: entry.voice, firstAudioMs: entry.first_audio_ms };
      case "interrupted": return { kind: "interrupted" };
      case "muted": return { kind: "muted" };
      case "error": return { kind: "error", detail: entry.error ?? "unknown error" };
      case "empty": return { kind: "error", detail: "nothing left to speak after stripping markup" };
    }
  }
  if (t.skipped) return { kind: t.skipped };
  if (t.turnAt !== null) return t.now - t.turnAt < PENDING_GRACE_MS ? { kind: "queued" } : { kind: "unspoken" };
  if (t.pendingAt != null && t.now - t.pendingAt < PENDING_GRACE_MS) return { kind: "queued" };
  // No turn for this card since it mounted (history, a sub-thread): a missing entry means "no record".
  return { kind: "unknown" };
}

export function needsPolling(state: CardState): boolean {
  return state.kind === "queued" || state.kind === "playing";
}

export function statusText(state: CardState): string {
  switch (state.kind) {
    case "queued": return "Queued";
    case "playing": return "Playing";
    case "spoken": {
      const parts = ["Spoken"];
      if (state.voice) parts.push(state.voice);
      if (state.firstAudioMs != null) parts.push(`${state.firstAudioMs} ms to first audio`);
      return parts.join(" · ");
    }
    case "interrupted": return "Interrupted";
    case "muted": return "Muted";
    case "off": return "Voice off";
    case "error": return `Error: ${state.detail}`;
    case "unspoken": return "Not spoken";
    case "unknown": return "No record";
  }
}
