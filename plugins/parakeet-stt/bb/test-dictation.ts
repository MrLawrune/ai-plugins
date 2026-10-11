// Fixtures for the dictation controller tests: a do-nothing target, and controllers with fake one-shot and streaming deps.
import { appendDictation, DictationController, type DictationDeps, type Interruption, type Target } from "./dictation.ts";

/** A target that does nothing; override only what a test observes. */
export function target(over: Partial<Target> = {}): Target {
  return { id: "t1", setLive() {}, commitLive() {}, begin() {}, clear() {}, end() {}, appendText() {}, submit() {}, ...over };
}

export function harness(over: Partial<DictationDeps> = {}) {
  const log: string[] = [];
  let interrupt: ((why: Interruption) => void) | null = null;
  const deps: DictationDeps = {
    async startRecording(onInterrupt) {
      interrupt = onInterrupt;
      log.push("rec:start");
      return { async stop() { log.push("rec:stop"); return new Blob(["x"]); }, cancel() { log.push("rec:cancel"); } };
    },
    async transcribe() { return "hello world"; },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: true, mode: "oneshot" as const, livePreview: true }),
    playSound: (n) => log.push(`sound:${n}`),
    notify: (k, m) => log.push(`${k}:${m}`),
    now: () => 0,
    ...over,
  };
  const c = new DictationController(deps);
  let draft = "fix the";
  c.register(target({ appendText: (t) => { draft = appendDictation(draft, t, false); }, submit: () => log.push("submit") }));
  return { c, log, draft: () => draft, interrupt: (w: Interruption) => interrupt!(w) };
}

export function streamHarness(over: Partial<DictationDeps> = {}) {
  const log: string[] = [];
  let handlers: import("./dictation.ts").StreamHandlers | null = null;
  let interrupt: ((w: Interruption) => void) | null = null;
  let draft = "Start.";
  let live = "";
  const deps: DictationDeps = {
    async startRecording() { log.push("oneshot:start"); return { async stop() { return new Blob(["x"]); }, cancel() {} }; },
    async transcribe() { return "one shot text"; },
    async startStream(h, onInterrupt) {
      handlers = h; interrupt = onInterrupt; log.push("stream:start");
      return {
        async stop() { log.push("stream:stop"); h.onEnded("stopped"); },
        cancel() { log.push("stream:cancel"); },
      };
    },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: false, mode: "continuous", livePreview: true }),
    playSound: () => {},
    notify: (k, m) => log.push(`${k}:${m}`),
    now: () => 0,
    ...over,
  };
  const c = new DictationController(deps);
  c.register(target({
    appendText: (t) => { draft = `${draft} ${t}`; },
    submit: () => log.push("submit"),
    setLive: (t) => { live = t; },
    commitLive: (t) => { live = ""; if (t) draft = `${draft} ${t}`; },
    begin: () => log.push("begin"),
    clear: () => { draft = ""; log.push("clear"); },
    end: () => log.push("end"),
  }));
  return { c, log, h: () => handlers!, interrupt: (w: Interruption) => interrupt!(w), draft: () => draft, live: () => live };
}
