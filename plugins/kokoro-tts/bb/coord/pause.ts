// Pause other media on this computer while Kokoro speaks, then resume it.
// Uses MPRIS through playerctl on Linux desktops. Only players that were
// playing get paused, and only those are resumed. Elsewhere, or without
// playerctl, it reports itself unsupported.
import { spawn, type ChildProcess } from "node:child_process";
import { findExecutable } from "../setup/uv.ts";

export type Runner = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<{ code: number; out: string }>;

const MAX_OUT = 64 * 1024;
const CMD_TIMEOUT_MS = 2000;

/** A Runner that resolves args[0] with `resolve` (once per name), so it finds the same binary `pauseSupported` saw. */
export function createRunCmd(resolve: (name: string) => string | null = (name) => findExecutable(name)): Runner {
  const resolved = new Map<string, string>();
  const locate = (name: string): string | null => {
    if (name.includes("/")) return name;
    let found = resolved.get(name) ?? null;
    if (found === null && (found = resolve(name)) !== null) resolved.set(name, found);
    return found;
  };
  return (args, timeoutMs, signal) =>
    new Promise((resolveRun) => {
      if (signal.aborted) return resolveRun({ code: 1, out: "" });
      const exe = locate(args[0]);
      if (exe === null) return resolveRun({ code: 127, out: "" });
      let child: ChildProcess;
      try {
        child = spawn(exe, args.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return resolveRun({ code: 1, out: "" });
      }
      let out = "";
      let done = false;
      const kill = () => { child.kill("SIGKILL"); };
      const timer = setTimeout(kill, timeoutMs);
      signal.addEventListener("abort", kill, { once: true });
      const finish = (r: { code: number; out: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
        resolveRun(r);
      };
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (d: string) => { if (out.length < MAX_OUT) out = (out + d).slice(0, MAX_OUT); });
      child.on("error", (e: NodeJS.ErrnoException) => finish({ code: e.code === "ENOENT" ? 127 : 1, out: "" }));
      child.on("close", (code) => finish({ code: code ?? 1, out }));
    });
}

/** spawn(args[0], args.slice(1)); 127 when the tool is missing; kills the child on timeout or abort; stdout capped at 64 KiB. */
export const runCmd: Runner = createRunCmd();

export function pauseSupported(
  platform: NodeJS.Platform = process.platform,
  hasPlayerctl: () => boolean = () => findExecutable("playerctl") !== null,
): boolean {
  return platform === "linux" && hasPlayerctl();
}

export interface PauserOpts {
  run?: Runner;
  releaseMs?: number;
  maxMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** Reference-counted: back-to-back replies share one pause/resume cycle. */
export class MediaPauser {
  #run: Runner;
  #releaseMs: number;
  #maxMs: number;
  #setTimer: (fn: () => void, ms: number) => unknown;
  #clearTimer: (h: unknown) => void;
  #active = new Set<string>();
  #paused: string[] = []; // MPRIS player names
  #applied = false;
  #release: unknown = null;
  #safety: unknown = null;
  #tail: Promise<unknown> = Promise.resolve();
  #abort = new AbortController();
  #disposed = false;

  constructor(opts: PauserOpts = {}) {
    this.#run = opts.run ?? runCmd;
    this.#releaseMs = opts.releaseMs ?? 500;
    this.#maxMs = opts.maxMs ?? 600_000;
    this.#setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.#clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get applied(): boolean {
    return this.#applied;
  }

  /** Speech `key` began. Returns whether other media is held paused for it. mode "keep" → false, no-op. */
  start(key: string, mode: "keep" | "pause"): Promise<boolean> {
    if (mode !== "pause" || this.#disposed) return Promise.resolve(false);
    return this.#locked(async () => {
      if (this.#disposed) return false;
      this.#active.add(key);
      this.#cancelRelease();
      if (this.#applied) return true;
      this.#applied = true;
      await this.#pause();
      // Never leave media paused if an end is lost.
      this.#safety = this.#setTimer(() => this.#resumeLater(true), this.#maxMs);
      return true;
    });
  }

  /** Speech `key` ended; resume releaseMs after the last active key ends. */
  end(key: string): Promise<void> {
    return this.#locked(async () => {
      if (!this.#active.delete(key)) return;
      if (this.#active.size > 0 || !this.#applied) return;
      this.#cancelRelease();
      this.#release = this.#setTimer(() => this.#resumeLater(false), this.#releaseMs);
    });
  }

  /** Force-resume everything it paused and clear timers (plugin dispose). */
  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#resume(true);
    this.#abort.abort();
  }

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn);
    this.#tail = next.catch(() => {});
    return next;
  }

  #cmd(args: string[]) {
    return this.#run(args, CMD_TIMEOUT_MS, this.#abort.signal);
  }

  /** Timer-fired resume: nobody awaits it, so a failing runner must not become an unhandled rejection. */
  #resumeLater(force: boolean): void {
    this.#resume(force).catch(() => {});
  }

  #resume(force: boolean): Promise<void> {
    return this.#locked(async () => {
      if (this.#active.size > 0 && !force) return; // the next reply started during the release delay
      this.#active.clear();
      this.#cancelRelease();
      if (this.#safety !== null) {
        this.#clearTimer(this.#safety);
        this.#safety = null;
      }
      for (const player of this.#paused) await this.#cmd(["playerctl", "-p", player, "play"]);
      this.#paused = [];
      this.#applied = false;
    });
  }

  #cancelRelease(): void {
    if (this.#release !== null) {
      this.#clearTimer(this.#release);
      this.#release = null;
    }
  }

  async #pause(): Promise<void> {
    const list = await this.#cmd(["playerctl", "-l"]);
    if (list.code !== 0) return;
    for (const player of list.out.split("\n").map((p) => p.trim()).filter(Boolean)) {
      const status = await this.#cmd(["playerctl", "-p", player, "status"]);
      if (status.out.trim() !== "Playing") continue;
      if ((await this.#cmd(["playerctl", "-p", player, "pause"])).code === 0) this.#paused.push(player);
    }
  }
}
