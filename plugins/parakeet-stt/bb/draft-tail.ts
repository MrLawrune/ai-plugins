// The live (dimmed) tail is always the draft's suffix. If the user edited the draft so it no longer
// ends with the tail, the next tail is appended after their edits.

function separator(base: string): string {
  return base === "" || /\s$/.test(base) ? "" : " ";
}

export function replaceTail(draft: string, prevTail: string, text: string): { draft: string; tail: string } {
  const base = prevTail && draft.endsWith(prevTail) ? draft.slice(0, draft.length - prevTail.length) : draft;
  const tail = text ? `${separator(base)}${text}` : "";
  return { draft: base + tail, tail };
}

export function tailRange(draft: string, tail: string): { from: number; to: number } | null {
  if (!tail || !draft.endsWith(tail)) return null;
  const lead = tail.length - tail.trimStart().length;
  return { from: draft.length - tail.length + lead, to: draft.length };
}


export interface LiveState {
  /** Insertion point in the draft (null = append at the end). */
  anchor: number | null;
  /** The dimmed text currently in the draft at the anchor (or at the end), "" when none. */
  tail: string;
  /** Phrase whose grey text was sent or cleared; its later partials and final are dropped. */
  dropSeq: number | null;
}

/** Start a dictation at the caret (or selection, which is removed), or at the end when caret is null. */
export function beginAt(draft: string, caret: { start: number; end: number } | null): { draft: string; state: LiveState } {
  if (!caret || caret.start < 0 || caret.end > draft.length) return { draft, state: { anchor: null, tail: "", dropSeq: null } };
  return { draft: draft.slice(0, caret.start) + draft.slice(caret.end), state: { anchor: caret.start, tail: "", dropSeq: null } };
}

function spaced(before: string, after: string, text: string): string {
  if (!text) return "";
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const trail = after === "" || /^[\s.,!?;:)\]]/.test(after) ? "" : " ";
  return `${lead}${text}${trail}`;
}

/**
 * Apply a partial (final=false) or final for phrase `seq`. The live text sits at the anchor (or the
 * end). If the draft is empty while a tail was showing, the user sent or cleared it: the rest of
 * that phrase is dropped instead of being re-inserted into the next message.
 */
export function applyLive(draft: string, state: LiveState, seq: number, text: string, final: boolean): { draft: string; state: LiveState } {
  if (state.dropSeq === seq) return { draft, state: final ? { ...state, tail: "", dropSeq: null } : state };
  let pos: number;
  let base = draft;
  if (state.anchor === null) {
    if (state.tail && draft.endsWith(state.tail)) base = draft.slice(0, draft.length - state.tail.length);
    else if (state.tail && draft.trim() === "") return { draft, state: { ...state, tail: "", dropSeq: final ? null : seq } };
    pos = base.length;
  } else {
    pos = Math.min(state.anchor, draft.length);
    if (state.tail) {
      const at = draft.startsWith(state.tail, pos) ? pos : draft.lastIndexOf(state.tail);
      if (at >= 0) {
        pos = at;
        base = draft.slice(0, at) + draft.slice(at + state.tail.length);
      } else if (draft.trim() === "") {
        return { draft, state: { anchor: null, tail: "", dropSeq: final ? null : seq } };
      }
    }
  }
  const before = base.slice(0, pos);
  const after = base.slice(pos);
  const tail = spaced(before, after, text);
  const next = before + tail + after;
  if (state.anchor === null) return { draft: next, state: { anchor: null, tail: final ? "" : tail, dropSeq: null } };
  return { draft: next, state: final ? { anchor: pos + tail.length, tail: "", dropSeq: null } : { anchor: pos, tail, dropSeq: null } };
}

/** Where to paint the dimmed tail in `draft`, or null. */
export function liveRange(draft: string, state: LiveState): { from: number; to: number } | null {
  if (!state.tail) return null;
  if (state.anchor === null) return tailRange(draft, state.tail);
  if (!draft.startsWith(state.tail, state.anchor)) return null;
  const lead = state.tail.length - state.tail.trimStart().length;
  return { from: state.anchor + lead, to: state.anchor + state.tail.trimEnd().length };
}

let current: LiveState = { anchor: null, tail: "", dropSeq: null };
export const liveState = {
  get: (): LiveState => current,
  set: (s: LiveState): void => { current = s; },
};
