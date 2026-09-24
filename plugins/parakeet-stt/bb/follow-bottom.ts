// Keeps matching scrollable elements pinned to their bottom as content is added, unless the user
// has scrolled up. Used for bb's collapsed phone composer so the newest dictated words stay visible.

export function nearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 8): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

export function followBottom(doc: Document, selector: string, signal: AbortSignal): void {
  const tracked = new WeakSet<Element>();
  const attach = (el: HTMLElement) => {
    if (tracked.has(el)) return;
    tracked.add(el);
    let stick = true;
    el.addEventListener("scroll", () => { stick = nearBottom(el); }, { passive: true, signal });
    const mo = new MutationObserver(() => { if (stick) el.scrollTop = el.scrollHeight; });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    signal.addEventListener("abort", () => mo.disconnect(), { once: true });
  };
  let queued = false;
  const scan = () => {
    queued = false;
    doc.querySelectorAll<HTMLElement>(selector).forEach(attach);
  };
  const body = new MutationObserver(() => {
    if (!queued) { queued = true; requestAnimationFrame(scan); }
  });
  body.observe(doc.body, { childList: true, subtree: true });
  signal.addEventListener("abort", () => body.disconnect(), { once: true });
  scan();
}
