// Frontend dictation state machine shared by the composer action, plus-menu item, banner,
// and keyboard shortcut. Browser specifics are injected so the logic runs under node:test.
import type { SoundName } from "./schemas.ts";
import type { EndReason } from "./stream-protocol.ts";

export type Mode = "continuous" | "oneshot";
export type Phase = "idle" | "recording" | "transcribing" | "streaming" | "finishing";
export interface DictationSnapshot { phase: Phase; targetId: string | null; startedAt: number | null }
export interface Target {
  id: string;
  appendText(text: string): void;
  submit(): void;
  /** Replace the dimmed live tail with `text` for phrase `seq` (empty clears it). */
  setLive(text: string, seq: number): void;
  /** Replace the live tail with solid `text` for phrase `seq` (empty just clears the tail). */
  commitLive(text: string, seq: number): void;
}
export interface StreamHandlers {
  onPartial(text: string, seq: number): void;
  onFinal(text: string, seq: number): void;
  onCommand(name: "send" | "stop"): void;
  onEnded(reason: EndReason): void;
  onError(message: string): void;
}
export interface StreamHandle { stop(): Promise<void>; cancel(): void }
export interface RecordingHandle { stop(): Promise<Blob>; cancel(): void }
export type Interruption = "hidden" | "limit" | "lost";
export interface DictationDeps {
  startRecording(onInterrupt: (why: Interruption) => void): Promise<RecordingHandle>;
  transcribe(audio: Blob): Promise<string>;
  startStream?(handlers: StreamHandlers, onInterrupt: (why: Interruption) => void): Promise<StreamHandle>;
  prefs(): { autoSubmit: boolean; trailingSpace: boolean; soundCues: boolean; mode: Mode; livePreview: boolean };
  playSound(name: SoundName): void;
  notify(kind: "info" | "error", message: string): void;
  now(): number;
}

const IDLE: DictationSnapshot = { phase: "idle", targetId: null, startedAt: null };
const INTERRUPT_NOTICE: Record<Interruption, string> = {
  hidden: "Recording stopped because the page was hidden; transcribing what was captured.",
  limit: "Recording reached the 5-minute limit; transcribing.",
  lost: "The browser turned the microphone off; transcribing what was captured.",
};

const STREAM_INTERRUPT_NOTICE: Record<Interruption, string> = {
  hidden: "Dictation stopped because the page was hidden.",
  limit: "Dictation reached its limit.",
  lost: "The browser turned the microphone off; dictation stopped and your text was kept.",
};

export function appendDictation(current: string, text: string, trailingSpace: boolean): string {
  const sep = current === "" || /\s$/.test(current) ? "" : " ";
  return `${current}${sep}${text}${trailingSpace ? " " : ""}`;
}

export function matchesShortcut(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  shortcut: string,
): boolean {
  if (shortcut === "off" || e.code !== "Space" || e.metaKey) return false;
  const want = new Set(shortcut.split("+"));
  return e.ctrlKey === want.has("ctrl") && e.altKey === want.has("alt") && e.shiftKey === want.has("shift");
}

export class DictationController {
  #deps: DictationDeps | null;
  #state: DictationSnapshot = IDLE;
  #targets: Target[] = [];
  #listeners = new Set<() => void>();
  #recording: RecordingHandle | null = null;
  /** stop() arrived while the mic prompt was still pending (e.g. hold-to-talk key released). */
  #stopRequested = false;
  #stream: StreamHandle | null = null;
  #live = "";
  #liveSeq = 0;

  constructor(deps: DictationDeps | null) {
    this.#deps = deps;
  }

  configure(deps: DictationDeps): void {
    this.#deps = deps;
  }

  snapshot(): DictationSnapshot {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The most recently registered or used target is the default for shortcuts. Several surfaces
   * (action, banner, plus menu) may register the same composer id; each unregisters only itself.
   */
  register(target: Target): () => void {
    this.#targets = [...this.#targets, target];
    this.#emit();
    return () => {
      this.#targets = this.#targets.filter((t) => t !== target);
      this.#emit();
    };
  }

  /** Number of mounted composer targets (the floating mic shows only when one exists). */
  targetCount(): number {
    return this.#targets.length;
  }

  async toggle(targetId?: string): Promise<void> {
    const phase = this.#state.phase;
    if (phase === "idle") return this.start(targetId);
    if (phase === "recording" || phase === "streaming") return this.stop();
  }

  /** Start in `mode` (default: the prefs mode). Continuous falls back to one-shot if streaming fails. */
  async start(targetId?: string, mode?: Mode): Promise<void> {
    const deps = this.#deps;
    if (this.#state.phase !== "idle" || !deps) return;
    const target = this.#resolve(targetId);
    if (!target) return;
    const wanted = mode ?? deps.prefs().mode;
    if (wanted === "continuous" && deps.startStream) return this.#startStream(deps, target);
    return this.#startOneShot(deps, target);
  }

  async #startStream(deps: DictationDeps, target: Target): Promise<void> {
    this.#set({ phase: "streaming", targetId: target.id, startedAt: deps.now() });
    this.#stopRequested = false;
    this.#live = "";
    const handlers: StreamHandlers = {
      onPartial: (text, seq) => {
        if (!deps.prefs().livePreview || this.snapshot().phase === "idle") return;
        this.#live = text;
        this.#liveSeq = seq;
        target.setLive(text, seq);
      },
      onFinal: (text, seq) => { this.#live = ""; target.commitLive(text, seq); },
      onCommand: (name) => { if (name === "send") target.submit(); },
      onError: (message) => deps.notify("error", message),
      onEnded: (reason) => this.#streamEnded(deps, target, reason),
    };
    let handle: StreamHandle;
    try {
      handle = await deps.startStream!(handlers, (why) => {
        if (this.snapshot().phase !== "streaming") return;
        deps.notify("info", STREAM_INTERRUPT_NOTICE[why]);
        void this.stop();
      });
    } catch (e) {
      this.#set(IDLE);
      deps.notify("info", `Streaming unavailable (${e instanceof Error ? e.message : String(e)}); using one-shot.`);
      return this.#startOneShot(deps, target);
    }
    if (this.snapshot().phase !== "streaming") {
      handle.cancel(); // cancelled while connecting
      return;
    }
    this.#stream = handle;
    this.#cue("start");
    if (this.#stopRequested) await this.stop();
  }

  #streamEnded(deps: DictationDeps, target: Target, reason: EndReason): void {
    if (this.snapshot().phase === "idle") return;
    if (reason === "error") {
      if (this.#live) target.commitLive(this.#live, this.#liveSeq);
      deps.notify("info", "Dictation connection lost; the last phrase may be incomplete.");
      this.#cue("error");
    } else {
      if (reason === "silence") deps.notify("info", "Dictation stopped after silence.");
      if (reason === "limit") deps.notify("info", "Dictation reached the 15-minute limit.");
      this.#cue("stop");
    }
    this.#live = "";
    this.#stream = null;
    this.#set(IDLE);
  }

  async #startOneShot(deps: DictationDeps, target: Target): Promise<void> {
    // Enter "recording" before the mic prompt resolves so a double press is ignored.
    this.#set({ phase: "recording", targetId: target.id, startedAt: deps.now() });
    this.#stopRequested = false;
    let handle: RecordingHandle;
    try {
      handle = await deps.startRecording((why) => {
        if (this.#state.phase !== "recording") return;
        deps.notify("info", INTERRUPT_NOTICE[why]);
        void this.stop();
      });
    } catch (e) {
      this.#recording = null;
      this.#set(IDLE);
      this.#cue("error");
      deps.notify("error", `Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (this.snapshot().phase !== "recording") {
      handle.cancel(); // cancelled while the mic prompt was pending
      return;
    }
    this.#recording = handle;
    this.#cue("start");
    if (this.#stopRequested) await this.stop();
  }

  async stop(): Promise<void> {
    if (this.#state.phase === "streaming") {
      if (!this.#stream) {
        this.#stopRequested = true;
        return;
      }
      const stream = this.#stream;
      this.#set({ ...this.#state, phase: "finishing" });
      await stream.stop();
      return;
    }
    const deps = this.#deps;
    const recording = this.#recording;
    if (this.#state.phase !== "recording" || !deps) return;
    if (!recording) {
      this.#stopRequested = true;
      return;
    }
    this.#stopRequested = false;
    const target = this.#resolve(this.#state.targetId ?? undefined);
    this.#recording = null;
    this.#set({ ...this.#state, phase: "transcribing" });
    try {
      const audio = await recording.stop();
      this.#cue("stop");
      const text = (await deps.transcribe(audio)).trim();
      if (!text) deps.notify("info", "No speech detected");
      else if (!target) deps.notify("info", "The composer closed before the text arrived; it is saved in Parakeet STT history.");
      else {
        target.appendText(text);
        if (deps.prefs().autoSubmit) target.submit();
      }
    } catch (e) {
      this.#cue("error");
      deps.notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      this.#set(IDLE);
    }
  }

  cancel(): void {
    if (this.#state.phase === "streaming" || this.#state.phase === "finishing") {
      const target = this.#resolve(this.#state.targetId ?? undefined);
      this.#stream?.cancel();
      this.#stream = null;
      this.#live = "";
      target?.setLive("", this.#liveSeq);
      this.#set(IDLE);
      this.#cue("cancel");
      return;
    }
    if (this.#state.phase !== "recording") return;
    this.#recording?.cancel();
    this.#recording = null;
    this.#set(IDLE);
    this.#cue("cancel");
  }

  #resolve(targetId?: string): Target | undefined {
    if (!targetId) return this.#targets.at(-1);
    const t = [...this.#targets].reverse().find((x) => x.id === targetId);
    if (t) this.#targets = [...this.#targets.filter((x) => x !== t), t];
    return t;
  }

  #cue(name: SoundName): void {
    if (this.#deps?.prefs().soundCues) this.#deps.playSound(name);
  }

  #set(next: DictationSnapshot): void {
    this.#state = next;
    this.#emit();
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

export const controller = new DictationController(null);
