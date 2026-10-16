export interface Ranged {
  from: number;
  to: number;
}

/**
 * Turn a plain-text rewrite of a draft into a replacement that keeps every @-mention.
 * Returns `null` when the changed region overlaps a mention (the caller must not write).
 * Returns the same `cur` object when `next === cur.text` (bb treats that as a no-op).
 *
 * The same edit can often be read at several offsets inside repeated text ("Alex" ->
 * "Alright Alex"). Every equivalent alignment is tried, nearest `at` first (else the
 * rightmost), and `null` is returned only if each one overlaps a mention.
 */
export function applyTextEdit<M extends Ranged>(
  cur: { text: string; mentions: readonly M[] },
  next: string,
  at?: number,
): { text: string; mentions: M[] } | typeof cur | null {
  const old = cur.text;
  if (next === old) return cur;
  const max = Math.min(old.length, next.length);
  let p = 0;
  while (p < max && old[p] === next[p]) p++;
  let maxSuffix = 0; // uncapped common suffix: how far an alignment may slide left
  while (maxSuffix < max && old[old.length - 1 - maxSuffix] === next[next.length - 1 - maxSuffix]) maxSuffix++;
  const s = Math.min(maxSuffix, max - p);
  const oldLen = old.length - p - s;
  const delta = next.length - old.length;

  const starts: number[] = [];
  for (let q = p; q >= Math.max(0, p - (maxSuffix - s)); q--) starts.push(q);
  if (at !== undefined) starts.sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || b - a);

  for (const q of starts) {
    const mentions: M[] = [];
    let ok = true;
    for (const m of cur.mentions) {
      if (m.to <= q) mentions.push(m);
      else if (m.from >= q + oldLen) mentions.push({ ...m, from: m.from + delta, to: m.to + delta });
      else {
        ok = false;
        break;
      }
    }
    if (ok) return { text: next, mentions };
  }
  return null;
}
