// Pure logic for the chat card: which speech-log entry belongs to a card and what its status line says.
import type { SpeechLogEntry } from "../schemas.ts";

/** The server stores at most this many characters of an entry's text. */
export const MAX_LOG_TEXT = 2000;
/** How long a card waits for its entry after its thread's turn before showing "Not spoken". */
export const PENDING_GRACE_MS = 25_000;

export type CardState =
  | { kind: "queued" }
  | { kind: "playing" }
  | { kind: "spoken"; voice?: string; firstAudioMs?: number }
  | { kind: "interrupted" }
  | { kind: "muted" }
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

export function cardState(
  entry: SpeechLogEntry | undefined,
  t: { turnAt: number | null; now: number },
): CardState {
  if (entry) {
    switch (entry.status) {
      case "queued": return { kind: "queued" };
      case "playing": return { kind: "playing" };
      case "done": return { kind: "spoken", voice: entry.voice, firstAudioMs: entry.first_audio_ms };
      case "interrupted": return { kind: "interrupted" };
      case "muted": return { kind: "muted" };
      case "error": return { kind: "error", detail: entry.error ?? "unknown error" };
      case "empty": return { kind: "error", detail: "nothing left to speak after stripping markup" };
    }
  }
  // No turn in this thread since the card mounted (history, a sub-thread): a missing entry means "no record".
  if (t.turnAt === null) return { kind: "unknown" };
  return t.now - t.turnAt < PENDING_GRACE_MS ? { kind: "queued" } : { kind: "unspoken" };
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
    case "error": return `Error: ${state.detail}`;
    case "unspoken": return "Not spoken";
    case "unknown": return "No record";
  }
}
