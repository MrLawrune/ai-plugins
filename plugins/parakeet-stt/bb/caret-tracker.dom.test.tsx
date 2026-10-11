import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { trackCaret } from "./caret-tracker.ts";

type Reg = { type: string; signal: AbortSignal | undefined };
let registered: Reg[];
let editor: HTMLElement;
let outside: HTMLElement;
let ctl: AbortController;

beforeEach(() => {
  registered = [];
  ctl = new AbortController(); // listeners live on the shared jsdom document, so each test cleans up its own
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation(((type: string, l: EventListenerOrEventListenerObject, o?: AddEventListenerOptions) => {
    registered.push({ type, signal: o?.signal });
    add(type, l, o);
  }) as typeof document.addEventListener);
  document.body.innerHTML = `<form data-promptbox><div class="ProseMirror" contenteditable="true"><p>hi</p></div></form><input id="other">`;
  editor = document.querySelector(".ProseMirror")!;
  outside = document.getElementById("other")!;
});

afterEach(() => {
  ctl.abort();
  vi.restoreAllMocks();
});

const live = () => registered.filter((r) => !r.signal?.aborted).map((r) => r.type).sort();

test("on a page with no focused composer only focusin and focusout are listened for", () => {
  trackCaret(ctl.signal);
  expect(live()).toEqual(["focusin", "focusout"]);
});

test("focusing the editor attaches caret listeners and leaving it removes them", () => {
  trackCaret(ctl.signal);
  editor.firstElementChild!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(live()).toEqual(["focusin", "focusout", "keyup", "pointerup", "selectionchange"]);
  editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
  expect(live()).toEqual(["focusin", "focusout"]);
});

test("focus outside any composer attaches nothing, and refocusing the editor does not stack listeners", () => {
  trackCaret(ctl.signal);
  outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(live()).toEqual(["focusin", "focusout"]);
  editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(live()).toEqual(["focusin", "focusout", "keyup", "pointerup", "selectionchange"]);
});

test("aborting the outer signal removes everything, including the per-focus listeners", () => {
  trackCaret(ctl.signal);
  editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  ctl.abort();
  expect(live()).toEqual([]);
});
