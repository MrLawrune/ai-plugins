import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { followBottom } from "../follow-bottom.ts";
import { DEFAULT_PREFS } from "../prefs.ts";
import { setDictationPrefs } from "../dictation-prefs.ts";
import { createSessionFollow } from "./session-follow.ts";

vi.mock("../follow-bottom.ts", () => ({ followBottom: vi.fn() }));

let layout: "compact" | "expanded" = "compact";
const sf = () => createSessionFollow(() => layout);
const calls = () => vi.mocked(followBottom).mock.calls;

/** A bb composer form with a compact editor; `visible: false` makes checkVisibility report hidden. */
function composerForm(visible = true): { form: HTMLFormElement; editor: HTMLElement } {
  const form = document.createElement("form");
  form.setAttribute("data-promptbox", "");
  form.innerHTML = '<div data-promptbox-compact-content><div class="ProseMirror" contenteditable="true"></div></div><input>';
  const editor = form.querySelector<HTMLElement>(".ProseMirror")!;
  (editor as unknown as { checkVisibility: () => boolean }).checkVisibility = () => visible;
  document.body.appendChild(form);
  return { form, editor };
}

beforeEach(() => {
  vi.mocked(followBottom).mockClear();
  layout = "compact";
  setDictationPrefs({ ...DEFAULT_PREFS, expandCompactDraft: true });
});
afterEach(() => { document.body.innerHTML = ""; });

test("nothing is followed without a session, however often it is synced", () => {
  composerForm();
  const f = sf();
  f.sync();
  f.sync();
  expect(followBottom).not.toHaveBeenCalled();
});

test("a session in the compact layout with the pref on follows the editor once", () => {
  const { editor } = composerForm();
  const f = sf();
  f.start();
  f.sync();
  f.sync();
  expect(calls()).toHaveLength(1);
  expect(calls()[0]![0]).toBe(editor);
  expect(calls()[0]![1].aborted).toBe(false);
});

test("an expanded layout or the pref off follows nothing", () => {
  composerForm();
  layout = "expanded";
  sf().start();
  layout = "compact";
  setDictationPrefs({ ...DEFAULT_PREFS, expandCompactDraft: false });
  sf().start();
  expect(followBottom).not.toHaveBeenCalled();
});

test("stop aborts the follow, and a later sync does not attach again", () => {
  composerForm();
  const f = sf();
  f.start();
  const signal = calls()[0]![1];
  f.stop();
  expect(signal.aborted).toBe(true);
  f.sync();
  expect(calls()).toHaveLength(1);
});

test("an editor replaced mid-session is followed again and the old follow is aborted", () => {
  const first = composerForm();
  const f = sf();
  f.start();
  const old = calls()[0]![1];
  first.form.remove();
  const second = composerForm();
  f.sync();
  expect(calls()).toHaveLength(2);
  expect(calls()[1]![0]).toBe(second.editor);
  expect(old.aborted).toBe(true);
  expect(calls()[1]![1].aborted).toBe(false);
});

test("leaving the compact layout or turning the pref off mid-session drops the follow", () => {
  composerForm();
  const f = sf();
  f.start();
  const signal = calls()[0]![1];
  layout = "expanded";
  f.sync();
  expect(signal.aborted).toBe(true);
  layout = "compact";
  f.sync();
  expect(calls()).toHaveLength(2);
  const second = calls()[1]![1];
  setDictationPrefs({ ...DEFAULT_PREFS, expandCompactDraft: false });
  f.sync();
  expect(second.aborted).toBe(true);
});

test("several composers: the one around the focused element wins, else the first visible", () => {
  const a = composerForm();
  const b = composerForm();
  b.form.querySelector("input")!.focus();
  const f = sf();
  f.start();
  expect(calls()[0]![0]).toBe(b.editor);
  f.stop();

  document.body.innerHTML = "";
  const hidden = composerForm(false);
  const shown = composerForm(true);
  (document.activeElement as HTMLElement | null)?.blur();
  const g = sf();
  g.start();
  expect(calls().at(-1)![0]).toBe(shown.editor);
  expect(calls().at(-1)![0]).not.toBe(hidden.editor);
  void a;
});

test("no editor in the page: no follow, and it attaches as soon as one appears", () => {
  const f = sf();
  f.start();
  expect(followBottom).not.toHaveBeenCalled();
  const { editor } = composerForm();
  f.sync();
  expect(calls()).toHaveLength(1);
  expect(calls()[0]![0]).toBe(editor);
});
