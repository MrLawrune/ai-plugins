// Linked conventions files (an existing AGENTS.md, runbook, …) read on the BB server and cached,
// so synchronous callers (pinned instructions) can include them.
import { open, stat } from "node:fs/promises";

export const CONVENTIONS_MAX_BYTES = 16 * 1024;
const TTL_MS = 30_000;
const READ_TIMEOUT_MS = 5_000;

/** At most CONVENTIONS_MAX_BYTES + 1 bytes of a regular file; special files and directories are rejected. */
async function readCapped(path: string): Promise<Buffer> {
  if (!(await stat(path)).isFile()) throw new Error("not a regular file");
  const fh = await open(path, "r");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const buf = Buffer.alloc(CONVENTIONS_MAX_BYTES + 1);
    const { bytesRead } = await Promise.race([
      fh.read(buf, 0, buf.length, 0),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("read timed out")), READ_TIMEOUT_MS); }),
    ]);
    return buf.subarray(0, bytesRead);
  } finally {
    clearTimeout(timer);
    await fh.close().catch(() => undefined);
  }
}

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
    const p = readCapped(path)
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
