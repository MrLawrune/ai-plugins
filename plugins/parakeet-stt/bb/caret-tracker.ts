// Browser side of caret capture: remembers the last caret/selection the user placed inside a bb
// composer editor. A caret is only handed out if the user moved it (tap/click/key) since the last
// dictation, so text inserted by the plugin never makes the next session insert before it.
import { locateCaret, type DomNode, type DomPoint } from "./caret.ts";

const EDITOR = "form[data-promptbox] .ProseMirror";
let last: { root: Element; start: DomPoint; end: DomPoint } | null = null;
let moved = false;

const editorOf = (n: Node | null): Element | null => (n instanceof Element ? n : n?.parentElement ?? null)?.closest(EDITOR) ?? null;
const point = (node: Node, offset: number): DomPoint => ({ node: node as unknown as DomNode, offset });

export function trackCaret(signal: AbortSignal): void {
  document.addEventListener("selectionchange", () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    const root = editorOf(r.startContainer);
    if (!root || editorOf(r.endContainer) !== root) return;
    last = { root, start: point(r.startContainer, r.startOffset), end: point(r.endContainer, r.endOffset) };
  }, { signal });
  const mark = (e: Event) => { if (editorOf(e.target as Node | null)) moved = true; };
  document.addEventListener("pointerdown", mark, { capture: true, signal });
  document.addEventListener("keydown", mark, { capture: true, signal });
}

/** The user-placed caret as draft offsets, or null (not moved, gone, or not mappable). Consumes it. */
export function takeCaret(draft: string): { start: number; end: number } | null {
  if (!moved || !last || !last.root.isConnected) return null;
  moved = false;
  return locateCaret(last.root as unknown as DomNode, last.start, last.end, draft);
}
