import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { followBottom } from "../follow-bottom.ts";
import { DEFAULT_PREFS } from "../prefs.ts";
import { setDictationPrefs } from "../dictation-prefs.ts";
import { makeTarget } from "./target.ts";
import { fakeComposer } from "./test-composer.ts";

vi.mock("../follow-bottom.ts", () => ({ followBottom: vi.fn() }));

// the real tracker reads the DOM selection; tests script the caret instead
vi.mock("../caret-tracker.ts", () => ({ notePluginEdit: vi.fn(), takeCaret: vi.fn(() => null) }));

// Follow-bottom exists only while a session writes into a compact composer.
function compactEditor(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-promptbox-compact-content", "");
  wrap.innerHTML = '<div class="ProseMirror" contenteditable="true"></div>';
  document.body.appendChild(wrap);
  return wrap.querySelector<HTMLElement>(".ProseMirror")!;
}
const followed = () => vi.mocked(followBottom).mock.calls;

afterEach(() => {
  document.body.innerHTML = "";
  vi.mocked(followBottom).mockClear();
  setDictationPrefs(DEFAULT_PREFS);
});

test("no session, no follow: nothing attaches before begin or after end", () => {
  const editor = compactEditor();
  const c = fakeComposer("hi");
  c.state.layout = "compact";
  const t = makeTarget("k1", () => c.api, vi.fn());
  t.setLive("x", 1);
  expect(followBottom).not.toHaveBeenCalled();
  t.begin();
  expect(followed().map((a) => a[0])).toEqual([editor]);
  t.end();
  expect(followed()[0]![1].aborted).toBe(true);
  t.commitLive("later", 2);
  expect(followBottom).toHaveBeenCalledTimes(1);
});

test("a session in a compact composer follows once across partials and finals", () => {
  const editor = compactEditor();
  const c = fakeComposer("");
  c.state.layout = "compact";
  const t = makeTarget("k1", () => c.api, vi.fn());
  t.begin();
  t.setLive("hel", 1);
  t.setLive("hello", 1);
  t.commitLive("hello.", 1);
  t.appendText("more");
  expect(followed()).toHaveLength(1);
  expect(followed()[0]![0]).toBe(editor);
  t.end();
});

test("an expanded composer or expandCompactDraft off follows nothing", () => {
  compactEditor();
  const c = fakeComposer("");
  const t = makeTarget("k1", () => c.api, vi.fn());
  t.begin();
  t.commitLive("hi", 1);
  t.end();
  c.state.layout = "compact";
  setDictationPrefs({ ...DEFAULT_PREFS, expandCompactDraft: false });
  t.begin();
  t.commitLive("hi", 2);
  t.end();
  expect(followBottom).not.toHaveBeenCalled();
});

test("an editor replaced mid-session is followed again on the next write", () => {
  const first = compactEditor();
  const c = fakeComposer("");
  c.state.layout = "compact";
  const t = makeTarget("k1", () => c.api, vi.fn());
  t.begin();
  first.closest("[data-promptbox-compact-content]")!.remove();
  const second = compactEditor();
  t.setLive("x", 1);
  expect(followed().map((a) => a[0])).toEqual([first, second]);
  expect(followed()[0]![1].aborted).toBe(true);
  t.end();
  expect(followed()[1]![1].aborted).toBe(true);
});
