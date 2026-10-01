// What one plugin load owns: an abort signal for its in-flight work, and the
// set of that work disposal waits for before the host closes the database.

/** One per plugin load: an abort signal plus the set of in-flight work disposal waits for. */
export class LoadScope {
  readonly #ctl = new AbortController();
  readonly #tracked = new Set<Promise<unknown>>();

  get signal(): AbortSignal {
    return this.#ctl.signal;
  }

  /** Adds `p` until it settles; returns `p` unchanged. */
  track<T>(p: Promise<T>): Promise<T> {
    const settled = p.then(() => undefined, () => undefined);
    this.#tracked.add(settled);
    void settled.then(() => this.#tracked.delete(settled));
    return p;
  }

  /** Abort, then wait for tracked work (at most timeoutMs, default 4000). */
  async dispose(timeoutMs = 4_000): Promise<void> {
    this.#ctl.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); });
    try {
      await Promise.race([Promise.all(this.#tracked), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
