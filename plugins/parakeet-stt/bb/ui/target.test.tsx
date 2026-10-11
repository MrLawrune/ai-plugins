import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { controller, type DictationDeps, type StreamHandlers, type Target } from "../dictation.ts";
import { takeCaret } from "../caret-tracker.ts";
import { liveState } from "../draft-tail.ts";
import { followBottom } from "../follow-bottom.ts";
import { DEFAULT_PREFS } from "../prefs.ts";
import { setDictationPrefs } from "../dictation-prefs.ts";
import { makeTarget, runDictation } from "./target.ts";

vi.mock("../follow-bottom.ts", () => ({ followBottom: vi.fn() }));

// the real tracker reads the DOM selection; tests script the caret instead
vi.mock("../caret-tracker.ts", () => ({ notePluginEdit: vi.fn(), takeCaret: vi.fn(() => null) }));

type Mention = { from: number; to: number; label: string; kind: "project"; projectId: string };
const pill = (from: number, to: number): Mention => ({ from, to, label: "Alex", kind: "project", projectId: "p" });

/** The slice of PluginComposerApi the target uses, over an in-memory draft. */
function fakeComposer(text: string, mentions: Mention[] = [], key = "k1") {
  const state = { text, mentions, blocked: false, reason: null as string | null, closed: false, layout: "expanded" as "compact" | "expanded" };
  const lock: boolean[] = [];
  const submit = vi.fn(async (_options: unknown) => {});
  const api = {
    key,
    get layout() { return state.layout; },
    get text() { return state.text; },
    get draft() { return { text: state.text, mentions: state.mentions, attachments: [] }; },
    get isSubmittingBlocked() { return state.blocked; },
    get submittingBlockedReason() { return state.reason; },
    replace(next: (cur: unknown) => { text: string; mentions: Mention[] }) {
      if (state.closed) throw new Error("This composer is no longer available.");
      const cur = api.draft;
      const r = next(cur);
      if (r !== cur) { state.text = r.text; state.mentions = r.mentions; }
    },
    setInputLock: (on: boolean) => {
      if (state.closed) throw new Error("This composer is no longer available.");
      lock.push(on);
    },
    submit,
  };
  return { api: api as unknown as PluginComposerApi, state, lock, submit };
}

let handlers: StreamHandlers;
const told = vi.fn();
let unregister: Array<() => void> = [];
const register = (t: Target) => { unregister.push(controller.register(t)); };

beforeEach(() => {
  liveState.set({ anchor: null, tail: "", dropSeq: null });
  controller.configure({
    async startRecording() { return { async stop() { return new Blob(["x"]); }, cancel() {} }; },
    async transcribe() { return ""; },
    async startStream(h) { handlers = h; return { async stop() { h.onEnded("stopped"); }, cancel() {} }; },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: false, mode: "continuous", livePreview: true }),
    playSound() {},
    notify: told,
    now: () => 0,
  } satisfies DictationDeps);
  told.mockClear();
});

afterEach(() => {
  controller.cancel();
  for (const off of unregister) off();
  unregister = [];
});

test("partial then final keep the @-mention range and release the input lock", () => {
  const c = fakeComposer("@Alex hi", [pill(0, 5)]);
  const t = makeTarget("k1", () => c.api, vi.fn());
  t.begin();
  t.setLive("hello", 1);
  expect(c.state.text).toBe("@Alex hi hello");
  t.commitLive("hello there.", 1);
  expect(c.state.text).toBe("@Alex hi hello there.");
  expect(c.state.mentions).toEqual([pill(0, 5)]);
  expect(c.lock).toEqual([true, false]);
});

test("text inserted before a mention shifts the mention by the inserted length", () => {
  const c = fakeComposer("@Alex hi", [pill(0, 5)]);
  const t = makeTarget("k1", () => c.api, vi.fn());
  liveState.set({ anchor: 0, tail: "", dropSeq: null });
  t.setLive("yo", 1);
  expect(c.state.text).toBe("yo @Alex hi");
  expect(c.state.mentions).toEqual([pill(3, 8)]);
});

test("an edit that lands on a mention stops dictation with a toast and leaves the draft alone", async () => {
  const c = fakeComposer("@Alex hi", [pill(0, 5)]);
  const notify = vi.fn();
  const t = makeTarget("k1", () => c.api, notify);
  register(t);
  await controller.start("k1");
  expect(controller.snapshot().phase).toBe("streaming");
  handlers.onPartial("foo", 1);
  expect(c.state.text).toBe("@Alex hi foo");
  // the user turns the dictated word into a pill, so the next rewrite of it would cut through it
  c.state.mentions = [pill(0, 5), pill(9, 12)];
  handlers.onPartial("fox", 2);
  expect(notify).toHaveBeenCalledWith("The draft changed under dictation; dictation stopped.", "error");
  expect(controller.snapshot().phase).toBe("idle");
  expect(c.state.text).toBe("@Alex hi foo");
  expect(c.state.mentions).toEqual([pill(0, 5), pill(9, 12)]);
  expect(c.lock.at(-1)).toBe(false);
});

test("after a conflict the session cannot auto-send a draft that lacks the dictated text", async () => {
  vi.useFakeTimers();
  try {
    const c = fakeComposer("@Alex hi", [pill(0, 5)]);
    const t = makeTarget("k1", () => c.api, vi.fn());
    t.begin();
    t.setLive("foo", 1);
    c.state.mentions = [pill(0, 5), pill(9, 12)];
    t.setLive("fox", 2);
    t.submit();
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.submit).not.toHaveBeenCalled();
    t.begin();
    t.submit();
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.submit).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("submit refuses when bb says submitting is blocked and shows the reason", async () => {
  const c = fakeComposer("hi");
  c.state.blocked = true;
  c.state.reason = "Uploads are still in progress";
  const notify = vi.fn();
  makeTarget("k1", () => c.api, notify).submit();
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Could not send: Uploads are still in progress", "error"));
  expect(c.submit).not.toHaveBeenCalled();
});

test("submit sends through composer.submit", async () => {
  const c = fakeComposer("hi");
  makeTarget("k1", () => c.api, vi.fn()).submit();
  await vi.waitFor(() => expect(c.submit).toHaveBeenCalledWith({ experimental_data: {} }));
});

test("end() releases the input lock", () => {
  const c = fakeComposer("hi");
  makeTarget("k1", () => c.api, vi.fn()).end();
  expect(c.lock).toEqual([false]);
});

test("two registrations for one composer count once and a closed composer drops out", () => {
  const c = fakeComposer("hi");
  const before = controller.targetCount();
  const off1 = controller.register(makeTarget("k1", () => c.api, vi.fn()));
  const off2 = controller.register(makeTarget("k1", () => c.api, vi.fn()));
  expect(controller.has("k1")).toBe(true);
  expect(controller.targetCount()).toBe(before + 1);
  off1();
  off2();
  expect(controller.targetCount()).toBe(before);
  expect(controller.has("k1")).toBe(false);
});

test("a temporary target for a composer without a mounted surface is removed when dictation ends", async () => {
  const c = fakeComposer("hi");
  const before = controller.targetCount();
  runDictation(c.api, "start");
  expect(controller.has("k1")).toBe(true);
  expect(controller.targetCount()).toBe(before + 1);
  await vi.waitFor(() => expect(controller.snapshot().phase).toBe("streaming"));
  handlers.onFinal("hello.", 1);
  expect(c.state.text).toBe("hi hello.");
  runDictation(c.api, "toggle"); // stops the session through the same target
  await vi.waitFor(() => expect(controller.has("k1")).toBe(false));
  expect(controller.targetCount()).toBe(before);
  expect(c.lock.at(-1)).toBe(false);
});

test("a temporary target is also removed when the start does nothing", async () => {
  const c = fakeComposer("hi");
  controller.cancel();
  controller.configure(undefined as unknown as DictationDeps); // not configured: start() is a no-op
  runDictation(c.api, "start");
  await vi.waitFor(() => expect(controller.has("k1")).toBe(false));
});

test("a mounted composer is used as is, without a second target", async () => {
  const c = fakeComposer("hi");
  register(makeTarget("k1", () => c.api, vi.fn()));
  const before = controller.targetCount();
  runDictation(c.api, "start");
  expect(controller.targetCount()).toBe(before);
  await vi.waitFor(() => expect(controller.snapshot().phase).toBe("streaming"));
  controller.cancel();
  expect(controller.has("k1")).toBe(true);
});

test("voice clear empties a draft that holds a mention, keeps the session, and releases the lock", async () => {
  const c = fakeComposer("@Alex hi", [pill(0, 5)]);
  const notify = vi.fn();
  const t = makeTarget("k1", () => c.api, notify);
  register(t);
  await controller.start("k1");
  handlers.onFinal("more.", 1);
  expect(c.state.text).toBe("@Alex hi more.");
  handlers.onCommand("clear");
  expect(c.state.text).toBe("");
  expect(c.state.mentions).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
  expect(controller.snapshot().phase).toBe("streaming");
  expect(c.lock.at(-1)).toBe(false);
  handlers.onFinal("Take two.", 2);
  expect(c.state.text).toBe("Take two.");
});

test("a composer that closes mid-session ends the session cleanly and nothing lands in another composer", async () => {
  const c1 = fakeComposer("one", [], "k1");
  const c2 = fakeComposer("two", [pill(0, 3)], "k2");
  const notify = vi.fn();
  const before = controller.targetCount();
  const off1 = controller.register(makeTarget("k1", () => c1.api, notify));
  register(makeTarget("k2", () => c2.api, vi.fn()));
  await controller.start("k1");
  handlers.onPartial("foo", 1);
  expect(c1.state.text).toBe("one foo");
  c1.state.closed = true; // the composer unmounts; its target unregisters
  off1();
  expect(told).toHaveBeenCalledWith("info", "The composer closed; dictation stopped.");
  expect(controller.snapshot().phase).toBe("idle");
  expect(() => handlers.onPartial("foo bar", 2)).not.toThrow();
  expect(() => handlers.onFinal("foo bar.", 2)).not.toThrow();
  expect(() => handlers.onCommand("send")).not.toThrow();
  expect(c2.state.text).toBe("two");
  expect(c2.lock).toEqual([]);
  expect(controller.targetCount()).toBe(before + 1); // only k2 is left
  expect(controller.has("k1")).toBe(false);
});

test("a selection that includes a mention is kept, dictation goes to the end and the user is told", () => {
  const c = fakeComposer("@Alex hi", [pill(0, 5)]);
  const notify = vi.fn();
  const t = makeTarget("k1", () => c.api, notify);
  t.begin();
  t.setLive("zz", 1);
  t.commitLive("zz", 1);
  expect(c.state.text).toBe("@Alex hi zz");
  // a stale anchor from the previous session must not win over the end
  liveState.set({ anchor: 2, tail: "", dropSeq: null });
  vi.mocked(takeCaret).mockReturnValueOnce({ start: 3, end: 8 }); // "ex hi" cuts through the pill
  t.begin();
  expect(c.state.text).toBe("@Alex hi zz");
  expect(liveState.get().anchor).toBeNull();
  expect(notify).toHaveBeenCalledWith("The selection includes a mention, so it was not replaced; dictating at the end.");
  t.setLive("yo", 2);
  expect(c.state.text).toBe("@Alex hi zz yo");
  expect(c.state.mentions).toEqual([pill(0, 5)]);
});

test("a selection without a mention is replaced by the dictation", () => {
  const c = fakeComposer("fix the bug now", []);
  const t = makeTarget("k1", () => c.api, vi.fn());
  vi.mocked(takeCaret).mockReturnValueOnce({ start: 4, end: 7 });
  t.begin();
  expect(c.state.text).toBe("fix  bug now");
  expect(liveState.get().anchor).toBe(4);
});

test("a failed write does not disable the composer for later sessions", () => {
  const c = fakeComposer("hi");
  const notify = vi.fn();
  const t = makeTarget("k1", () => c.api, notify);
  c.state.closed = true; // replace throws once, e.g. a transient failure
  t.begin();
  expect(notify).toHaveBeenCalledWith("The composer closed; dictation stopped.");
  c.state.closed = false;
  t.begin();
  t.setLive("hello", 1);
  t.commitLive("hello.", 1);
  expect(c.state.text).toBe("hi hello.");
});

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
