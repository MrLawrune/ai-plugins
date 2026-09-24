// Browser-side prefs cache shared by the composer surfaces and the settings page.
import { DEFAULT_PREFS } from "./prefs.ts";
import type { Prefs } from "./schemas.ts";

let current: Prefs = DEFAULT_PREFS;
export const dictationPrefs = (): Prefs => current;
export function setDictationPrefs(next: Prefs): void { current = next; }
