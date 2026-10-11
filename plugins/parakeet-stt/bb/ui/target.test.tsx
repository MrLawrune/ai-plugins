import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { controller, type DictationDeps, type StreamHandlers, type Target } from "../dictation.ts";
import { liveState } from "../draft-tail.ts";
import { makeTarget, runDictation } from "./target.ts";

type Mention = { from: number; to: number; label: string; kind: "project"; projectId: string };
const pill = (from: number, to: number): Mention => ({ from, to, label: "Alex", kind: "project", projectId: "p" });

/** The slice of PluginComposerApi the target uses, over an in-memory draft. */
function fakeComposer(text: string, mentions: Mention[] = []) {
  const state = { text, mentions, blocked: false, reason: null as string | null };
  const lock: boolean[] = [];
  const submit = vi.fn(async (_options: unknown) => {});
  const api = {
    key: "k1",
    get text() { return state.text; },
    get draft() { return { text: state.text, mentions: state.mentions, attachments: [] }; },
    get isSubmittingBlocked() { return state.blocked; },
    get submittingBlockedReason() { return state.reason; },
    replace(next: (cur: unknown) => { text: string; mentions: Mention[] }) {
      const cur = api.draft;
      const r = next(cur);
      if (r !== cur) { state.text = r.text; state.mentions = r.mentions; }
    },
    setInputLock: (on: boolean) => { lock.push(on); },
    submit,
  };
  return { api: api as unknown as PluginComposerApi, state, lock, submit };
}

let handlers: StreamHandlers;
let unregister: Array<() => void> = [];
const register = (t: Target) => { unregister.push(controller.register(t)); };
// a draft that differs from the last plugin edit makes submit wait out its bounded settle loop
const SETTLE = { timeout: 3000 };

beforeEach(() => {
  liveState.set({ anchor: null, tail: "", dropSeq: null });
  controller.configure({
    async startRecording() { return { async stop() { return new Blob(["x"]); }, cancel() {} }; },
    async transcribe() { return ""; },
    async startStream(h) { handlers = h; return { async stop() { h.onEnded("stopped"); }, cancel() {} }; },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: false, mode: "continuous", livePreview: true }),
    playSound() {},
    notify() {},
    now: () => 0,
  } satisfies DictationDeps);
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
  expect(notify).toHaveBeenCalledWith("The draft changed under dictation; dictation stopped.");
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
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Could not send: Uploads are still in progress"), SETTLE);
  expect(c.submit).not.toHaveBeenCalled();
});

test("submit sends through composer.submit", async () => {
  const c = fakeComposer("hi");
  makeTarget("k1", () => c.api, vi.fn()).submit();
  await vi.waitFor(() => expect(c.submit).toHaveBeenCalledWith({ experimental_data: {} }), SETTLE);
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
