// Main/backup failover over engines, with a circuit breaker on the main engine.
import { sentenceChunks } from "../coord/speakable.ts";
import { EngineError, MAX_PIECE_BYTES, SAMPLE_RATE, type Engine, type EngineHealth, type Pcm, type SynthOpts } from "./types.ts";

export type Slot = "main" | "backup";
/** `only`: use exactly this slot (previews) — no failover, breaker untouched. */
export interface ReplyOpts extends SynthOpts { leadInMs: number; gapMs: number; only?: Slot }
export interface BreakerState { state: "closed" | "open" | "half-open"; until: number | null }
export interface ChainDeps {
  engines: () => { main: Engine; backup: Engine | null };
  now?: () => number;
  firstFrameMs?: number;      // 8000
  firstFrameColdMs?: number;  // 30000
  interFrameMs?: number;      // 15000
  cooldownMs?: number;        // 30000
}

const UNREACHABLE = "unreachable: ";
/** First-frame budget per attempt, and for an engine whose model is not loaded. */
export const FIRST_FRAME_MS = 8_000;
export const FIRST_FRAME_COLD_MS = 30_000;
/** An engine that has not spoken for this long may have unloaded its model. */
export const WARM_FOR_MS = 10 * 60_000;

/** What the chain knows about one slot's engine, for picking its first-frame budget. */
interface SlotState {
  /** The engine's model is loaded: from /health, or true once it produced audio. */
  loaded: boolean | null;
  /** When it last produced a reply's first audio. */
  audioAt: number | null;
  /** Its last attempt went unanswered; a retry gets the short budget. */
  unanswered: boolean;
}

function silence(ms: number): Uint8Array {
  return new Uint8Array(Math.round((SAMPLE_RATE * ms) / 1000) * 4);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Engine audio with its silence in front, cut into pieces of at most
 * MAX_PIECE_BYTES. A model batch can be several megabytes; the silence is
 * never a piece of its own, since it is shorter than a piece.
 */
function* pieces(head: Uint8Array, pcm: Pcm): Generator<Pcm> {
  const all = concat(head, pcm);
  for (let o = 0; o < all.length; o += MAX_PIECE_BYTES) yield all.subarray(o, o + MAX_PIECE_BYTES);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class Timeout extends Error {}

/**
 * One engine call for one chunk: its own AbortController linked to the reply's
 * signal, and timed pulls. `close()` must run in a `finally`.
 */
class Pull {
  private readonly attempt = new AbortController();
  private readonly it: AsyncIterator<Pcm>;
  private readonly signal: AbortSignal;
  private readonly onAbort = (): void => this.attempt.abort();
  private pending = false;

  constructor(engine: Engine, chunk: string, opts: SynthOpts, signal: AbortSignal) {
    this.signal = signal;
    if (signal.aborted) this.attempt.abort();
    else signal.addEventListener("abort", this.onAbort, { once: true });
    try {
      this.it = engine.synthesize(chunk, opts, this.attempt.signal)[Symbol.asyncIterator]();
    } catch (e) {
      signal.removeEventListener("abort", this.onAbort);
      throw e;
    }
  }

  /** Next frame, or null at the end. Throws Timeout (after aborting the attempt) when `ms` elapses first. */
  async next(ms: number): Promise<Pcm | null> {
    // An abort listener added now would never fire; don't wait on the engine or the timer.
    if (this.attempt.signal.aborted) throw new EngineError("cancelled", "cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    const pulled = this.it.next();
    this.pending = true;
    pulled.then(() => { this.pending = false; }, () => { this.pending = false; });
    const lost = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
      stop = () => resolve("aborted");
      this.attempt.signal.addEventListener("abort", stop, { once: true });
    });
    try {
      const r = await Promise.race([pulled, lost]);
      if (r === "timeout") {
        this.attempt.abort();
        throw new Timeout();
      }
      if (r === "aborted") throw new EngineError("cancelled", "cancelled");
      return r.done ? null : r.value;
    } finally {
      clearTimeout(timer);
      if (stop) this.attempt.signal.removeEventListener("abort", stop);
      // A pull that lost the race settles later; keep its rejection handled.
      pulled.catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.signal.removeEventListener("abort", this.onAbort);
    this.attempt.abort();
    const done = Promise.resolve(this.it.return?.()).catch(() => undefined);
    // An engine stuck in a pull it ignores abort for would block return() forever.
    if (!this.pending) await done;
  }
}

export class EngineChain {
  private readonly deps: ChainDeps;
  private readonly now: () => number;
  private state: BreakerState = { state: "closed", until: null };
  private readonly slots = new Map<Slot, SlotState>();
  /** Bumped by reset(): a reply started under an older configuration writes no state. */
  private gen = 0;

  constructor(deps: ChainDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  breaker(): BreakerState {
    return { ...this.state };
  }

  /** A health probe of the engine at `url`; ignored when that slot now holds another engine. */
  noteHealth(slot: Slot, h: EngineHealth, url: string): void {
    const { main, backup } = this.deps.engines();
    if ((slot === "main" ? main : backup)?.url !== url || !h.reachable) return;
    this.slot(slot).loaded = h.loaded;
  }

  /** The engines changed: forget the breaker and what was known about them. */
  reset(): void {
    this.gen++;
    this.state = { state: "closed", until: null };
    this.slots.clear();
  }

  private slot(slot: Slot): SlotState {
    let s = this.slots.get(slot);
    if (!s) this.slots.set(slot, (s = { loaded: null, audioAt: null, unanswered: false }));
    return s;
  }

  /**
   * The long budget for an engine that may be loading its model: its health
   * said not loaded, or it has not spoken in WARM_FOR_MS (a GPU engine
   * unloads when idle) and its last attempt did not go unanswered.
   */
  private cold(slot: Slot): boolean {
    const s = this.slot(slot);
    if (s.loaded === false) return true;
    const recent = s.audioAt !== null && this.now() - s.audioAt < WARM_FOR_MS;
    return !recent && !s.unanswered;
  }

  private candidates(only: Slot | undefined): Array<{ slot: Slot; engine: Engine }> {
    const { main, backup } = this.deps.engines();
    if (only === "main") return [{ slot: "main", engine: main }];
    if (only === "backup") {
      if (!backup) throw new EngineError("config", "no backup engine configured");
      return [{ slot: "backup", engine: backup }];
    }
    const all: Array<{ slot: Slot; engine: Engine }> = [{ slot: "main", engine: main }];
    if (backup) all.push({ slot: "backup", engine: backup });
    if (this.state.state === "open") {
      if (this.now() < (this.state.until ?? 0)) {
        if (backup) return [{ slot: "backup", engine: backup }];
      } else {
        this.state = { state: "half-open", until: null };
      }
    }
    return all;
  }

  /** Yields PCM for the whole reply; calls onEngine once with the slot/url that produced the first audio. Throws EngineError on failure. */
  async *synthesize(text: string, opts: ReplyOpts, signal: AbortSignal, onEngine?: (slot: Slot, url: string) => void): AsyncGenerator<Pcm> {
    const chunks = sentenceChunks(text);
    if (chunks.length === 0) return;
    const { leadInMs, gapMs, only, ...synth } = opts;
    const firstFrameMs = this.deps.firstFrameMs ?? FIRST_FRAME_MS;
    const coldMs = this.deps.firstFrameColdMs ?? FIRST_FRAME_COLD_MS;
    const interFrameMs = this.deps.interFrameMs ?? 15_000;
    const cooldownMs = this.deps.cooldownMs ?? 30_000;

    // State writes belong to the configuration this reply started under.
    const gen = this.gen;
    const current = () => gen === this.gen;
    // First chunk: try candidates in order until one produces audio.
    let won: { slot: Slot; engine: Engine; pull: Pull; first: Pcm } | undefined;
    let lastErr: EngineError | undefined;
    for (const { slot, engine } of this.candidates(only)) {
      let attempt: Pull | undefined;
      try {
        attempt = new Pull(engine, chunks[0], synth, signal);
        const frame = await attempt.next(this.cold(slot) ? coldMs : firstFrameMs);
        if (!frame) throw new EngineError("stream", "the engine returned no audio");
        won = { slot, engine, pull: attempt, first: frame };
        break;
      } catch (e) {
        await attempt?.close();
        if (signal.aborted || (e instanceof EngineError && e.kind === "cancelled")) throw new EngineError("cancelled", "cancelled");
        let err: EngineError;
        if (e instanceof Timeout) err = new EngineError("unreachable", `${UNREACHABLE}no audio from ${engine.url} in time`);
        else if (e instanceof EngineError) err = e;
        else err = new EngineError("stream", message(e));
        if (err.kind === "unreachable" && !err.message.startsWith(UNREACHABLE)) {
          err = new EngineError("unreachable", `${UNREACHABLE}${err.message}`, err.status);
        }
        if (err.kind === "unreachable" && current()) {
          // What /health said no longer holds; the next attempt gets the short budget.
          Object.assign(this.slot(slot), { loaded: null, unanswered: true });
          if (!only && slot === "main") this.state = { state: "open", until: this.now() + cooldownMs };
        }
        lastErr = err;
      }
    }
    if (!won) throw lastErr ?? new EngineError("stream", "no engine produced audio");
    const committed = won.engine;
    let pull = won.pull;

    try {
      if (current()) {
        Object.assign(this.slot(won.slot), { loaded: true, audioAt: this.now(), unanswered: false });
        if (!only && won.slot === "main") this.state = { state: "closed", until: null };
      }
      onEngine?.(won.slot, committed.url);
      yield* pieces(silence(leadInMs), won.first);
      for (let i = 0; ; ) {
        let frame: Pcm | null;
        let gap: Uint8Array = new Uint8Array(0);
        try {
          frame = await pull.next(interFrameMs);
          if (!frame) {
            // This chunk is done: move the committed engine on to the next one.
            await pull.close();
            if (++i >= chunks.length) return;
            pull = new Pull(committed, chunks[i], synth, signal);
            const head = await pull.next(firstFrameMs);
            if (!head) throw new EngineError("stream", "the engine returned no audio");
            frame = head;
            gap = silence(gapMs);
          }
        } catch (e) {
          if (signal.aborted || (e instanceof EngineError && e.kind === "cancelled")) throw new EngineError("cancelled", "cancelled");
          if (e instanceof Timeout) throw new EngineError("stream", "engine stalled");
          // Only "nothing could be spoken" errors may carry the unreachable prefix.
          const detail = message(e).replace(/^unreachable: /, "");
          throw new EngineError("stream", `engine failed mid-reply: ${detail}`, e instanceof EngineError ? e.status : undefined);
        }
        yield* pieces(gap, frame);
      }
    } finally {
      await pull.close();
    }
  }
}
