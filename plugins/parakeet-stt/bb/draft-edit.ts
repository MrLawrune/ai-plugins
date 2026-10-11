export interface Ranged {
  from: number;
  to: number;
}

/**
 * Turn a plain-text rewrite of a draft into a replacement that keeps every @-mention.
 * Returns `null` when the changed region overlaps a mention (the caller must not write).
 * Returns the same `cur` object when `next === cur.text` (bb treats that as a no-op).
 */
export function applyTextEdit<M extends Ranged>(
  cur: { text: string; mentions: readonly M[] },
  next: string,
): { text: string; mentions: M[] } | typeof cur | null {
  const old = cur.text;
  if (next === old) return cur;
  const max = Math.min(old.length, next.length);
  let p = 0;
  while (p < max && old[p] === next[p]) p++;
  let s = 0;
  while (s < max - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  const oldEnd = old.length - s;
  const delta = next.length - old.length;
  const mentions: M[] = [];
  for (const m of cur.mentions) {
    if (m.to <= p) mentions.push(m);
    else if (m.from >= oldEnd) mentions.push({ ...m, from: m.from + delta, to: m.to + delta });
    else return null;
  }
  return { text: next, mentions };
}
