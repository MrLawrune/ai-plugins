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

let current = "";
export const liveTail = {
  get: (): string => current,
  set: (t: string): void => { current = t; },
};
