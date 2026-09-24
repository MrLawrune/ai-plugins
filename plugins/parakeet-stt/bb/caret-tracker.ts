// Browser side of caret capture: remembers the last caret/selection inside a bb composer editor.
// A caret is only handed out if the user moved it since the last dictation; selection changes the
// plugin itself causes (its draft edits) are ignored, so the next session does not jump back.
import { locateCaret, type DomNode, type DomPoint } from "./caret.ts";

const EDITOR = "form[data-promptbox] .ProseMirror";
/** The editor plus its padding, excluding the composer's buttons (tapping the mic is not a move). */
const INPUT_REGION = "form[data-promptbox] [data-promptbox-input-region], form[data-promptbox] .ProseMirror";
/** Selection changes this soon after a plugin edit are the editor reacting to that edit. */
const PLUGIN_ECHO_MS = 300;

export class CaretMoves {
  #echoMs: number;
  #lastPluginEdit = -Infinity;
  #moved = false;

  constructor(echoMs: number) {
    this.#echoMs = echoMs;
  }

  pluginEdit(now: number): void {
    this.#lastPluginEdit = now;
  }

  selectionChanged(now: number): void {
    if (now - this.#lastPluginEdit > this.#echoMs) this.#moved = true;
  }

  userInput(): void {
    this.#moved = true;
  }

  /** True once per user move. */
  take(): boolean {
    const moved = this.#moved;
    this.#moved = false;
    return moved;
  }
}

const moves = new CaretMoves(PLUGIN_ECHO_MS);
let last: { root: Element; start: DomPoint; end: DomPoint } | null = null;

const elementOf = (n: Node | null): Element | null => (n instanceof Element ? n : n?.parentElement ?? null);
const point = (node: Node, offset: number): DomPoint => ({ node: node as unknown as DomNode, offset });

/** Call right before the plugin changes the draft. */
export function notePluginEdit(): void {
  moves.pluginEdit(performance.now());
}

export function trackCaret(signal: AbortSignal): void {
  document.addEventListener("selectionchange", () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    const root = elementOf(r.startContainer)?.closest(EDITOR) ?? null;
    if (!root || elementOf(r.endContainer)?.closest(EDITOR) !== root) return;
    last = { root, start: point(r.startContainer, r.startOffset), end: point(r.endContainer, r.endOffset) };
    moves.selectionChanged(performance.now());
  }, { signal });
  const mark = (e: Event) => { if (elementOf(e.target as Node | null)?.closest(INPUT_REGION)) moves.userInput(); };
  document.addEventListener("pointerup", mark, { capture: true, signal });
  document.addEventListener("keyup", mark, { capture: true, signal });
}

/** The user-placed caret as draft offsets, or null (not moved, gone, or not mappable). Consumes it. */
export function takeCaret(draft: string): { start: number; end: number } | null {
  if (!moves.take() || !last || !last.root.isConnected) return null;
  return locateCaret(last.root as unknown as DomNode, last.start, last.end, draft);
}
