// Frontend dictation state machine shared by the composer action, plus-menu item, banner,
// and keyboard shortcut. Browser specifics are injected so the logic runs under node:test.
import type { SoundName } from "./schemas.ts";

export type Phase = "idle" | "recording" | "transcribing";
export interface DictationSnapshot { phase: Phase; targetId: string | null; startedAt: number | null }
export interface Target { id: string; appendText(text: string): void; submit(): void }
export interface RecordingHandle { stop(): Promise<Blob>; cancel(): void }
export type Interruption = "hidden" | "limit";
export interface DictationDeps {
  startRecording(onInterrupt: (why: Interruption) => void): Promise<RecordingHandle>;
  transcribe(audio: Blob): Promise<string>;
  prefs(): { autoSubmit: boolean; trailingSpace: boolean; soundCues: boolean };
  playSound(name: SoundName): void;
  notify(kind: "info" | "error", message: string): void;
  now(): number;
}

const IDLE: DictationSnapshot = { phase: "idle", targetId: null, startedAt: null };
const INTERRUPT_NOTICE: Record<Interruption, string> = {
  hidden: "Recording stopped because the page was hidden; transcribing what was captured.",
  limit: "Recording reached the 5-minute limit; transcribing.",
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
    return () => { this.#targets = this.#targets.filter((t) => t !== target); };
  }

  async toggle(targetId?: string): Promise<void> {
    if (this.#state.phase === "idle") return this.start(targetId);
    if (this.#state.phase === "recording") return this.stop();
  }

  async start(targetId?: string): Promise<void> {
    const deps = this.#deps;
    if (this.#state.phase !== "idle" || !deps) return;
    const target = this.#resolve(targetId);
    if (!target) return;
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
    for (const l of this.#listeners) l();
  }
}

export const controller = new DictationController(null);
