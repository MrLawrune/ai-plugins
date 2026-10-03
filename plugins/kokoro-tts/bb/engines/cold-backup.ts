// A cold local backup: the managed server is started only when the main
// engine fails, and stopped again once the main server is back and the backup
// has been unused for a while. Never two servers in normal operation.
import type { Supervisor } from "../supervisor.ts";
import { sleep as realSleep } from "../util.ts";
import type { EngineHealth, Pcm } from "./types.ts";

/** How long a reply waits for the stopped backup to start before it fails. */
export const COLD_START_MS = 30_000;
/** The backup is stopped once it has been unused this long with the main server healthy. */
export const COLD_IDLE_MS = 10 * 60_000;
/** How often the main server's health is checked while the backup runs. */
export const COLD_CHECK_MS = 60_000;

export interface ColdBackupDeps {
  /** Null when the plugin install is broken and no local server can start. */
  supervisor: () => Pick<Supervisor, "demand" | "release" | "demanded" | "ready"> & {
    status(): { state: string };
  } | null;
  /** The main engine's health, checked while the backup runs. */
  mainHealth: (signal: AbortSignal) => Promise<EngineHealth>;
  /** The main server answers again: replies go back to it. */
  mainBack: (health: EngineHealth) => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  startMs?: number;
  idleMs?: number;
  checkMs?: number;
}

export class ColdBackup {
  readonly #deps: ColdBackupDeps;
  readonly #now: () => number;
  /** The start replies are waiting on, shared by all of them. */
  #starting: Promise<"started" | undefined> | null = null;
  /** Replies the backup is speaking now. */
  #speaking = 0;
  /** When the backup was last tried or last finished a reply. */
  #usedAt = 0;
  /** Ends the pending start's wait early (unloading). */
  #abandon: ((cause: Error) => void) | null = null;
  #disposed = false;

  constructor(deps: ColdBackupDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Before the backup slot is tried: a stopped backup is started, and the
   * reply waits (bounded) until it answers. "started" when the plugin just
   * started it (its model is loaded), so the chain gives it the warm
   * first-frame budget; an adopted server's model may be unloaded, so the
   * chain's own rules decide for it.
   */
  ensure(_signal: AbortSignal): Promise<"started" | void> {
    if (this.#disposed) return Promise.reject(new Error("unloading"));
    const sup = this.#deps.supervisor();
    if (!sup) return Promise.reject(new Error("the local server is not installed"));
    this.#usedAt = this.#now();
    const { state } = sup.status();
    if (sup.demanded() && (state === "running" || state === "external")) return Promise.resolve();
    if (this.#starting) return this.#starting;
    sup.demand();
    const ms = this.#deps.startMs ?? COLD_START_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the local server did not start within ${ms / 1000} s`)), ms);
      this.#abandon = reject;
    });
    const answered = sup.ready().then(() => (sup.status().state === "running" ? "started" as const : undefined));
    const starting = Promise.race([answered, late]).finally(() => {
      clearTimeout(timer);
      if (this.#starting === starting) {
        this.#starting = null;
        this.#abandon = null;
      }
    });
    this.#starting = starting;
    return starting;
  }

  /**
   * Wraps one reply's synthesis: `used` is called when the backup won it, and
   * the backup counts as in use until the reply ends.
   */
  async *serve(run: (used: () => void) => AsyncIterable<Pcm>): AsyncGenerator<Pcm> {
    let using = false;
    try {
      yield* run(() => {
        if (using) return;
        using = true;
        this.#speaking++;
        this.#usedAt = this.#now();
      });
    } finally {
      if (using) {
        this.#speaking--;
        this.#usedAt = this.#now();
      }
    }
  }

  /** One cool-down check: only while the backup runs, and never mid-reply or mid-start. */
  async check(signal: AbortSignal): Promise<void> {
    const sup = this.#deps.supervisor();
    if (!sup?.demanded()) return;
    let health: EngineHealth;
    try {
      health = await this.#deps.mainHealth(signal);
    } catch {
      return;
    }
    if (signal.aborted || !health.reachable || health.forwards) return;
    this.#deps.mainBack(health);
    if (this.#speaking > 0 || this.#starting) return;
    if (this.#now() - this.#usedAt >= (this.#deps.idleMs ?? COLD_IDLE_MS)) sup.release();
  }

  /** Unloading: a pending start fails now (its timer is cleared) and no new one begins. */
  dispose(): void {
    this.#disposed = true;
    this.#abandon?.(new Error("unloading"));
  }

  /** BB background-service entry: a cool-down check every minute. */
  async watch(signal: AbortSignal): Promise<void> {
    const sleep = this.#deps.sleep ?? realSleep;
    const every = this.#deps.checkMs ?? COLD_CHECK_MS;
    while (!signal.aborted) {
      await sleep(every, signal);
      if (signal.aborted) return;
      await this.check(signal);
    }
  }
}
