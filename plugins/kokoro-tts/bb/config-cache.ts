// The Kokoro server's config and mute state as last seen. Every GET/PATCH
// /config and /mute response in this process updates it; a slow poll catches
// changes made elsewhere (another bb, curl) and backs off while the server is down.
import type { ConfigResponse } from "./schemas.ts";
import { sleep as realSleep } from "./util.ts";

const POLL_MS = 60_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export class ConfigCache {
  #fetch: () => Promise<ConfigResponse>;
  #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  #value: ConfigResponse | null = null;
  /** Bumped by every write, so a fetch that started before one does not overwrite it. */
  #version = 0;

  constructor(fetch: () => Promise<ConfigResponse>, sleep = realSleep) {
    this.#fetch = fetch;
    this.#sleep = sleep;
  }

  /** The last config seen, or null before the first successful fetch. */
  get(): ConfigResponse | null {
    return this.#value;
  }

  set(next: ConfigResponse): void {
    this.#version++;
    this.#value = next;
  }

  setMuted(muted: boolean): void {
    this.#version++;
    if (this.#value) this.#value = { ...this.#value, muted };
  }

  /** Forgets the config (the server URL changed). */
  clear(): void {
    this.#version++;
    this.#value = null;
  }

  /** Fetches the config from the server and keeps it, unless a newer write landed meanwhile. */
  async refresh(): Promise<ConfigResponse> {
    const version = this.#version;
    const next = await this.#fetch();
    if (version !== this.#version) return this.#value ?? next;
    this.#value = next;
    return next;
  }

  /** The cached config, fetched first if there is none yet. */
  current(): Promise<ConfigResponse> {
    return this.#value ? Promise.resolve(this.#value) : this.refresh();
  }

  /** Runs until signal aborts: refresh every minute, retrying from 5 s (doubling to 60 s) while unreachable. */
  async poll(signal: AbortSignal): Promise<void> {
    let retryMs = RETRY_MIN_MS;
    while (!signal.aborted) {
      try {
        await this.refresh();
        retryMs = RETRY_MIN_MS;
        await this.#sleep(POLL_MS, signal);
      } catch {
        await this.#sleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
  }
}
