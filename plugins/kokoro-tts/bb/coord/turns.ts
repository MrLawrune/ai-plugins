// What a voiced thread's events sound like: turn end -> speech or a cue,
// a prompt -> the attention ping, a new turn -> stop. Each thread's calls run
// one after another on its own promise chain.
import { createHash } from "node:crypto";
import type { PlayerHub } from "../hub.ts";
import type { Mode, Settings } from "../schemas.ts";
import { LruMap, LruSet } from "./lru.ts";
import { stripMarkdown } from "./speakable.ts";
import type { SpeechLogStore } from "./speech-log.ts";
import { capSpeech, extractDirective, route, routeCue } from "./turn.ts";

export interface TurnDeps {
  settings: () => Settings;
  muted: () => boolean;
  log: Pick<SpeechLogStore, "add" | "setStatus" | "deleteThread">;
  hub: Pick<PlayerHub, "speak" | "sound" | "stop" | "hasReadyClient">;
  /**
   * bb.realtime.publish. "kokoro-turn" tells chat cards a thread's turn is
   * being decided ({ threadId, pending: true }) and then what became of it
   * ({ threadId, action, text?, say?, muted? }: text is the speech-log text it
   * made, say the reply's directive say, muted whether mute silenced it).
   */
  publish: (channel: string, payload: unknown) => void;
  warn: (message: string) => void;
}

type Outcome = { action: "speech" | "sound" | "silent"; text?: string; muted?: boolean };

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const REPEAT_THREADS = 500;
const SPOKE_THREADS = 2000;
const REPLAY_MAX_CHARS = 2000;
const TOMBSTONES = 2000;

/** The log's voice name: the voice, or a blend's voices joined " + "; null for an empty blend. */
export function voiceLabel(voice: Settings["voice"]): string | null {
  if (typeof voice === "string") return voice;
  const names = Object.keys(voice);
  return names.length ? names.join(" + ") : null;
}

export class TurnCoordinator {
  #deps: TurnDeps;
  /** The tail of each thread's chain; removed once it settles with nothing queued behind it. */
  #chains = new Map<string, Promise<void>>();
  /** SHA-1 of each thread's last voiced turn text, so the same reply is not spoken twice. */
  #repeats = new LruMap<string, string>(REPEAT_THREADS);
  /** Threads that have made a sound here; a child among them still needs stopping after it is switched off. */
  #spoke = new LruSet<string>(SPOKE_THREADS);
  /** The plugin is unloading: queued and later steps do nothing. */
  #disposed = false;
  /**
   * Bumped for a thread each time it is deleted, so a replay whose existence
   * lookup began before the deletion cannot log the deleted thread's text again.
   */
  #deletions = new LruMap<string, number>(TOMBSTONES);

  constructor(deps: TurnDeps) {
    this.#deps = deps;
  }

  idle(threadId: string, text: string, mode: Mode): Promise<void> {
    return this.#enqueue(threadId, () => this.#idle(threadId, text, mode));
  }

  attention(threadId: string, mode: Mode): Promise<void> {
    return this.#enqueue(threadId, () => {
      if (this.#deps.muted()) return;
      const s = this.#deps.settings();
      if (routeCue("attention", mode, s).action !== "sound") return;
      this.#deps.hub.sound("attention", s.sound_volume, threadId);
      this.#spoke.add(threadId);
    });
  }

  interrupt(threadId: string): Promise<void> {
    return this.#enqueue(threadId, () => this.#deps.hub.stop(threadId));
  }

  archived(threadId: string): Promise<void> {
    return this.#enqueue(threadId, () => this.#forget(threadId));
  }

  deleted(threadId: string): Promise<void> {
    // State and log rows go first, so a failing stop never keeps a deleted thread's text.
    this.#deletions.set(threadId, (this.#deletions.get(threadId) ?? 0) + 1);
    return this.#enqueue(threadId, () => {
      this.#repeats.delete(threadId);
      this.#spoke.delete(threadId);
      try {
        this.#deps.log.deleteThread(threadId);
      } finally {
        this.#deps.hub.stop(threadId);
      }
    });
  }

  /**
   * Speaks text again, logged under the thread. `exists` (false only for a
   * thread known to be gone) is asked first; the insert runs in the thread's
   * chain and is refused if the thread was deleted since the lookup began.
   */
  async replay(
    threadId: string, text: string, exists: (threadId: string) => Promise<boolean> = async () => true,
  ): Promise<{ status: "playing" | "no_window" | "empty_after_strip" | "unsupported" }> {
    if (this.#disposed) throw new Error("the Kokoro plugin is unloading");
    if (!this.#deps.hub.hasReadyClient()) return { status: "no_window" };
    const deletions = this.#deletions.get(threadId) ?? 0;
    if (!(await exists(threadId))) return { status: "unsupported" };
    // Deleted (or unloading) while the lookup ran: nothing is logged or spoken.
    let run: () => ReturnType<TurnCoordinator["replay"]> = async () => ({ status: "unsupported" });
    await this.#enqueue(threadId, () => {
      if ((this.#deletions.get(threadId) ?? 0) !== deletions) return;
      try {
        const result = this.#replay(threadId, text);
        run = async () => result;
      } catch (cause) {
        run = async () => { throw cause; };
      }
    });
    return run();
  }

  #replay(threadId: string, text: string): { status: "playing" | "no_window" | "empty_after_strip" } {
    const { hub, log } = this.#deps;
    if (!hub.hasReadyClient()) return { status: "no_window" };
    const s = this.#deps.settings();
    const t = Array.from(text.trim()).slice(0, REPLAY_MAX_CHARS).join("");
    const spoken = s.strip_markdown ? stripMarkdown(t) : t;
    if (!spoken) return { status: "empty_after_strip" };
    const entry = log.add(t, threadId, voiceLabel(s.voice));
    this.#spoke.add(threadId);
    this.#speak(entry.id, spoken, threadId, s.speech_gain);
    return { status: "playing" };
  }

  hasSpoken(threadId: string): boolean {
    return this.#spoke.has(threadId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#chains.clear();
    this.#repeats = new LruMap(REPEAT_THREADS);
    this.#spoke = new LruSet(SPOKE_THREADS);
  }

  #idle(threadId: string, raw: string, mode: Mode): void {
    const text = raw.trim();
    if (!text) return;
    const say = extractDirective(text)[1];
    const sayField = say ? { say } : {};
    const publish = (o: Outcome) => this.#deps.publish("kokoro-turn", { threadId, ...o, ...sayField });
    this.#deps.publish("kokoro-turn", { threadId, pending: true });
    let outcome: Outcome = { action: "silent" };
    try {
      if (this.#deps.muted()) {
        outcome = { action: "silent", muted: true };
        return;
      }
      const key = createHash("sha1").update(text).digest("hex");
      if (this.#repeats.get(threadId) === key) return;
      try {
        outcome = this.#play(threadId, text, mode);
      } catch (cause) {
        // A failed turn is not heard, so the same text may try again.
        this.#repeats.delete(threadId);
        throw cause;
      }
      this.#repeats.set(threadId, key);
    } catch (cause) {
      this.#deps.warn(`turn ${threadId}: ${message(cause)}`);
    } finally {
      publish(outcome);
    }
  }

  #play(threadId: string, text: string, mode: Mode): Outcome {
    const { hub, log } = this.#deps;
    const s = this.#deps.settings();
    const r = route(text, mode, s);
    if (r.action === "silent") return { action: "silent" };
    this.#spoke.add(threadId);
    if (r.action === "sound") {
      hub.sound(r.sound, s.sound_volume, threadId);
      return { action: "sound" };
    }
    const entry = log.add(r.text, threadId, voiceLabel(s.voice));
    const spoken = s.strip_markdown ? stripMarkdown(r.text) : r.text;
    if (!spoken) {
      log.setStatus(entry.id, "empty");
      hub.sound("done", s.sound_volume, threadId);
      return { action: "sound", text: entry.text };
    }
    this.#speak(entry.id, spoken, threadId, s.speech_gain, mode);
    return { action: "speech", text: entry.text };
  }

  /**
   * hub.speak for a logged row; a throw marks the row `error` so it never stays
   * `queued`. `mode`: the reply's mode, for the error cue when nothing could be
   * spoken (a replay is the user's own action and gets none).
   */
  #speak(entryId: number, spoken: string, threadId: string, gain: number, mode?: Mode): void {
    try {
      this.#deps.hub.speak(entryId, capSpeech(spoken), threadId, gain, undefined, mode);
    } catch (cause) {
      this.#deps.log.setStatus(entryId, "error", { error: message(cause) });
      throw cause;
    }
  }

  #forget(threadId: string): void {
    this.#repeats.delete(threadId);
    this.#spoke.delete(threadId);
    this.#deps.hub.stop(threadId);
  }

  /** Runs step after the thread's earlier calls settle; a step that throws is warned and never breaks the chain. */
  #enqueue(threadId: string, step: () => void): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const run = () => {
      if (this.#disposed) return;
      try {
        step();
      } catch (cause) {
        this.#deps.warn(`${threadId}: ${message(cause)}`);
      }
    };
    const next = (this.#chains.get(threadId) ?? Promise.resolve()).then(run);
    this.#chains.set(threadId, next);
    void next.then(() => {
      if (this.#chains.get(threadId) === next) this.#chains.delete(threadId);
    }).catch(() => {});
    return next;
  }
}
