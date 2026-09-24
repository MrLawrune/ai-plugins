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
  /** The dimmed suffix currently in the draft ("" when none). */
  tail: string;
  /** Phrase whose grey text was sent or cleared; its later partials and final are dropped. */
  dropSeq: number | null;
}

/**
 * Apply a partial (final=false) or final for phrase `seq` to the draft. If the draft is empty while a
 * tail was showing, the user sent or cleared it: the rest of that phrase is dropped instead of being
 * re-inserted into the next message.
 */
export function applyLive(draft: string, state: LiveState, seq: number, text: string, final: boolean): { draft: string; state: LiveState } {
  if (state.dropSeq === seq) return { draft, state: final ? { tail: "", dropSeq: null } : state };
  if (state.tail && !draft.endsWith(state.tail) && draft.trim() === "") {
    return { draft, state: { tail: "", dropSeq: final ? null : seq } };
  }
  const r = replaceTail(draft, state.tail, text);
  return { draft: r.draft, state: { tail: final ? "" : r.tail, dropSeq: null } };
}

let current: LiveState = { tail: "", dropSeq: null };
export const liveState = {
  get: (): LiveState => current,
  set: (s: LiveState): void => { current = s; },
};
