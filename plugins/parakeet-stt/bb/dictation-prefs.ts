// Browser-side prefs cache shared by the composer surfaces, content scripts, and the settings page.
import { DEFAULT_PREFS } from "./prefs.ts";
import type { Prefs } from "./schemas.ts";

let current: Prefs = DEFAULT_PREFS;
const listeners = new Set<(p: Prefs) => void>();

export const dictationPrefs = (): Prefs => current;

export function setDictationPrefs(next: Prefs): void {
  current = next;
  for (const l of listeners) l(next);
}

export function onDictationPrefs(fn: (p: Prefs) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
