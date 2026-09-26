// Linked conventions files (an existing AGENTS.md, runbook, …) read on the BB server and cached,
// so synchronous callers (pinned instructions) can include them.
import { readFile } from "node:fs/promises";

export const CONVENTIONS_MAX_BYTES = 16 * 1024;
const TTL_MS = 30_000;

export class Conventions {
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; text: string }>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Cached text (possibly stale) or null if never loaded; refreshes in the background when stale. */
  cached(path: string): string | null {
    const hit = this.cache.get(path);
    if (!hit || this.now() - hit.at >= TTL_MS) void this.load(path);
    return hit?.text ?? null;
  }

  load(path: string): Promise<string> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < TTL_MS) return Promise.resolve(hit.text);
    const inflight = this.pending.get(path);
    if (inflight) return inflight;
    const p = readFile(path)
      .then((buf) => buf.length > CONVENTIONS_MAX_BYTES
        ? `${buf.subarray(0, CONVENTIONS_MAX_BYTES).toString("utf8")}\n… (truncated at ${CONVENTIONS_MAX_BYTES / 1024} KiB)`
        : buf.toString("utf8"))
      .catch(() => `(conventions file not readable: ${path})`)
      .then((text) => { this.cache.set(path, { at: this.now(), text }); return text; })
      .finally(() => this.pending.delete(path));
    this.pending.set(path, p);
    return p;
  }
}
