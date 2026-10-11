import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { controller, type DictationDeps, type StreamHandlers, type Target } from "../dictation.ts";
import { takeCaret } from "../caret-tracker.ts";
import { liveState } from "../draft-tail.ts";
import { followBottom } from "../follow-bottom.ts";
import { DEFAULT_PREFS } from "../prefs.ts";
import { setDictationPrefs } from "../dictation-prefs.ts";
import { makeTarget, runDictation } from "./target.ts";
import { fakeComposer, pill } from "./test-composer.ts";

vi.mock("../follow-bottom.ts", () => ({ followBottom: vi.fn() }));

// the real tracker reads the DOM selection; tests script the caret instead
vi.mock("../caret-tracker.ts", () => ({ notePluginEdit: vi.fn(), takeCaret: vi.fn(() => null) }));

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

test("another writer editing the dictated range ends the session instead of re-appending", async () => {
  const c = fakeComposer("base");
  const notify = vi.fn();
  register(makeTarget("k1", () => c.api, notify));
  await controller.start("k1");
  handlers.onPartial("hello", 1);
  expect(c.state.text).toBe("base hello");
  c.state.text = "base edited"; // another draft writer changed the live range
  handlers.onPartial("hello world", 2);
  expect(notify).toHaveBeenCalledWith("The draft changed under dictation; dictation stopped.", "error");
  expect(controller.snapshot().phase).toBe("idle");
  expect(c.state.text).toBe("base edited");
  expect(c.lock.at(-1)).toBe(false);
});

test("an anchored session whose live text moved away from its anchor also stops", async () => {
  const c = fakeComposer("abc");
  vi.mocked(takeCaret).mockReturnValueOnce({ start: 1, end: 1 });
  const notify = vi.fn();
  register(makeTarget("k1", () => c.api, notify));
  await controller.start("k1");
  handlers.onPartial("mid", 1);
  expect(c.state.text).toBe("a mid bc");
  c.state.text = "XX a mid bc"; // text inserted before the anchor shifts the live range
  handlers.onPartial("middle", 2);
  expect(notify).toHaveBeenCalledWith("The draft changed under dictation; dictation stopped.", "error");
  expect(c.state.text).toBe("XX a mid bc");
});

test("a draft that was sent or cleared while a partial showed still drops the rest of that phrase", async () => {
  const c = fakeComposer("");
  const notify = vi.fn();
  register(makeTarget("k1", () => c.api, notify));
  await controller.start("k1");
  handlers.onPartial("hello", 1);
  c.state.text = ""; // the draft was sent
  handlers.onPartial("hello there", 1);
  handlers.onFinal("hello there.", 1);
  expect(c.state.text).toBe("");
  expect(notify).not.toHaveBeenCalled();
  expect(controller.snapshot().phase).toBe("streaming");
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
  await new Promise((r) => setTimeout(r, 50)); // the controller judges a closed composer after a frame
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
