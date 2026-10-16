// Keeps newly dictated text visible in bb's collapsed (compact) composer: while a dictation session is
// running, the compact editor follows its bottom. Nothing is observed or listened to outside a session.
import { dictationPrefs } from "../dictation-prefs.ts";
import { followBottom } from "../follow-bottom.ts";

const COMPACT_EDITOR = "[data-promptbox-compact-content] .ProseMirror";

const visible = (el: HTMLElement): boolean => (typeof el.checkVisibility === "function" ? el.checkVisibility() : true);

/** The compact editor to follow: the one in the form holding focus when several are on screen, else the first visible. */
function findCompactEditor(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(COMPACT_EDITOR));
  if (all.length < 2) return all[0] ?? null;
  const form = document.activeElement?.closest("form");
  return (form && all.find((el) => form.contains(el))) || all.find(visible) || all[0]!;
}

/**
 * `layout` reports the composer's layout. Call `start()` when a session begins, `sync()` after each
 * write (re-attaches when the editor was replaced, detaches when the layout or pref no longer applies)
 * and `stop()` when the session ends.
 */
export function createSessionFollow(layout: () => string): { start(): void; sync(): void; stop(): void } {
  let active = false;
  let el: HTMLElement | null = null;
  let ctl: AbortController | null = null;
  const detach = () => {
    ctl?.abort();
    ctl = null;
    el = null;
  };
  const sync = () => {
    if (!active) return;
    if (!dictationPrefs().expandCompactDraft || layout() !== "compact") return detach();
    if (el?.isConnected) return;
    detach();
    const next = findCompactEditor();
    if (!next) return;
    el = next;
    ctl = new AbortController();
    followBottom(next, ctl.signal);
  };
  return {
    start() { active = true; sync(); },
    sync,
    stop() { active = false; detach(); },
  };
}
