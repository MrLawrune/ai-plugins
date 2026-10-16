// Keeps one scrollable element pinned to its bottom as content is added, unless the user has
// scrolled up. Used for bb's collapsed phone composer so the newest dictated words stay visible.

export function nearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 8): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

export function followBottom(el: HTMLElement, signal: AbortSignal): void {
  let stick = true;
  el.addEventListener("scroll", () => { stick = nearBottom(el); }, { passive: true, signal });
  const mo = new MutationObserver(() => { if (stick) el.scrollTop = el.scrollHeight; });
  mo.observe(el, { childList: true, subtree: true, characterData: true });
  el.scrollTop = el.scrollHeight; // the write that re-attached us may already be in the editor
  signal.addEventListener("abort", () => mo.disconnect(), { once: true });
}
