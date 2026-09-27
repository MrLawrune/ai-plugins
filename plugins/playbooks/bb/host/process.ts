// Local process helpers for the host entry: capture a command's output with limits, or stream it line by line.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface CaptureOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }
export interface CaptureResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Run to completion and collect stdout and stderr. Rejects with `too_large…`, `timeout…`, or `aborted…`. */
export function runCapture(cmd: string, args: string[], o: CaptureOptions = {}): Promise<CaptureResult> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let total = 0;
    let settled = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminate(child.pid);
      reject(e);
    };
    const onAbort = () => fail(new Error(`aborted: ${cmd} was cancelled`));
    const timer = setTimeout(() => fail(new Error(`timeout: ${cmd} exceeded ${timeoutMs} ms`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    };
    if (o.signal?.aborted) return onAbort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) return fail(new Error(`too_large: ${cmd} produced more than ${maxBytes} bytes`));
      into.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", (e) => fail(e));
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

function terminate(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const t = setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 2000);
  t.unref();
}

export interface StreamHandlers { onLine: (line: string, source: "stdout" | "stderr") => void; onExit: (code: number | null, signal: NodeJS.Signals | null) => void; onError?: (error: Error) => void }
export interface StreamHandle { pid: number; kill: (signal?: NodeJS.Signals) => void }

/**
 * Spawn a long-running command in its own process group and forward every line. stderr lines are
 * delivered with a `stderr: ` prefix so a single consumer sees both. `onExit` fires once, after the
 * last line, and `kill` signals the whole group (falling back to the pid alone).
 */
export function startStreaming(cmd: string, args: string[], h: StreamHandlers): StreamHandle {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let pendingStreams = 2;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const maybeDone = () => {
    if (pendingStreams === 0 && exit !== null) h.onExit(exit.code, exit.signal);
  };
  const wire = (stream: NodeJS.ReadableStream, source: "stdout" | "stderr") => {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => h.onLine(source === "stderr" ? `stderr: ${line}` : line, source));
    rl.on("close", () => {
      pendingStreams -= 1;
      maybeDone();
    });
  };
  wire(child.stdout, "stdout");
  wire(child.stderr, "stderr");
  child.on("error", (e) => h.onError?.(e));
  child.on("close", (code, signal) => {
    exit = { code, signal };
    maybeDone();
  });
  const pid = child.pid ?? -1;
  return {
    pid,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (pid <= 0) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          /* already gone */
        }
      }
    },
  };
}
