// Brings the local Kokoro server up when an engine slot uses it: adopt a
// running one, else uv -> models -> runtime -> spawn (headless), and keep it
// alive. State feeds the page.
import { isLoopback } from "./kokoro-client.ts";
import type { Prefs, SetupState } from "./schemas.ts";
import { SetupError } from "./setup/errors.ts";
import { UV_INSTALL_COMMAND } from "./setup/uv.ts";

export interface ServerProcess {
  /** Numeric exit code, `signal <NAME>` when killed by a signal, or the spawn error message. */
  exited: Promise<number | string | null>;
  kill(signal: NodeJS.Signals): void;
}

export interface SupervisorDeps {
  /** Whether an engine slot uses the local server; when not, nothing is checked or spawned. */
  needed(): boolean;
  health(): Promise<boolean>;
  prefs(): Prefs;
  serverUrl(): string;
  findUv(): string | null;
  ensureModels(onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void>;
  syncRuntime(uv: string, runtime: "cpu" | "gpu", signal: AbortSignal): Promise<void>;
  spawnServer(o: { runtime: "cpu" | "gpu"; headless: boolean }): ServerProcess;
  gpuAvailable(): boolean;
  /** The running server's configured engine provider and whether it can build a CUDA session. */
  engineProvider(signal: AbortSignal): Promise<{ provider: string; cudaAvailable: boolean }>;
  /** Switches the running server's engine provider (PATCH /config). */
  setProvider(provider: "cpu" | "cuda", signal: AbortSignal): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

export class Supervisor {
  #deps: SupervisorDeps;
  #state: SetupState;
  #restartCtl: AbortController | null = null;
  #uvWaiter: (() => void) | null = null;
  #uvFailure: string | null = null;

  constructor(deps: SupervisorDeps) {
    this.#deps = deps;
    this.#state = { state: "checking", detail: null, progress: null, fixCommand: null, headless: null, gpuAvailable: deps.gpuAvailable() };
  }

  status(): SetupState {
    return this.#state;
  }

  restart(): void {
    this.#restartCtl?.abort();
  }

  uvInstalled(): void {
    this.#uvFailure = null;
    this.#uvWaiter?.();
  }

  /** The uv installer failed: keep waiting in needs-uv, but show why and the manual command. */
  uvInstallFailed(message: string): void {
    this.#uvFailure = message;
    if (this.#state.state === "needs-uv") this.#set(this.#needsUvState());
    this.#uvWaiter?.();
  }

  #needsUvState(): Partial<SetupState> {
    return {
      state: "needs-uv",
      detail: this.#uvFailure
        ? `Installing uv failed: ${this.#uvFailure} Run the command below in a terminal, then retry.`
        : "uv is needed to install the Kokoro server.",
      fixCommand: UV_INSTALL_COMMAND,
    };
  }

  /** BB background-service entry: resolves on abort, rejects on crash. */
  async start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const inner = new AbortController();
      const relay = () => inner.abort();
      signal.addEventListener("abort", relay, { once: true });
      this.#restartCtl = inner;
      try {
        await this.#run(inner.signal);
        if (!inner.signal.aborted) return;
      } catch (cause) {
        if (!inner.signal.aborted) {
          this.#set({
            state: "error",
            detail: cause instanceof Error ? cause.message : String(cause),
            fixCommand: cause instanceof SetupError ? cause.fixCommand : null,
            progress: null,
          });
          throw cause;
        }
      } finally {
        signal.removeEventListener("abort", relay);
      }
    }
  }

  #set(patch: Partial<SetupState>): void {
    this.#state = { ...this.#state, ...patch };
  }

  async #run(signal: AbortSignal): Promise<void> {
    const d = this.#deps;
    if (!d.needed()) {
      // A settings change that starts using the local server calls restart().
      this.#set({ state: "external", detail: "No local engine is configured.", progress: null, fixCommand: null, headless: null });
      while (!signal.aborted) await d.sleep(60_000, signal);
      return;
    }
    this.#set({ state: "checking", detail: null, progress: null, fixCommand: null, headless: null });
    if (await d.health()) return this.#adopt(signal);

    const url = d.serverUrl();
    const { manageServer, runtime } = d.prefs();
    if (!manageServer || !isLoopback(url)) {
      this.#set({ state: "error", detail: `Kokoro server not reachable at ${url}` });
      while (!signal.aborted) {
        await d.sleep(10_000, signal);
        if (!signal.aborted && (await d.health())) return this.#adopt(signal);
      }
      return;
    }

    let uv = d.findUv();
    while (!uv) {
      this.#set(this.#needsUvState());
      await Promise.race([new Promise<void>((r) => { this.#uvWaiter = r; }), d.sleep(5_000, signal)]);
      this.#uvWaiter = null;
      if (signal.aborted) return;
      uv = d.findUv();
    }

    this.#set({ state: "downloading-models", detail: "Downloading the voice model (about 355 MB).", progress: 0, fixCommand: null });
    await d.ensureModels((fraction) => this.#set({ progress: fraction }), signal);
    if (signal.aborted) return;

    this.#set({
      state: "installing-runtime",
      detail: runtime === "gpu" ? "Installing the GPU runtime (about 2.5 GB)." : "Installing the CPU runtime.",
      progress: null,
    });
    await d.syncRuntime(uv, runtime, signal);
    if (signal.aborted) return;

    this.#set({ state: "starting", detail: null, headless: true });
    const proc = d.spawnServer({ runtime, headless: true });
    // From here until this run ends, an abort stops the child, whatever step is pending.
    let stopping: Promise<void> | null = null;
    const stop = () => (stopping ??= this.#stopProc(proc));
    const onAbort = () => { void stop(); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.#waitHealthy(proc, signal);

      if (result.kind === "exited") {
        if (signal.aborted) return;
        throw new Error(`Kokoro server exited with code ${result.code} during startup (see plugin logs)`);
      }

      // Abort could have landed exactly as the final health() check resolved true (or as
      // the deadline was reached): don't claim "running" for a server being stopped.
      if (signal.aborted) {
        await stop();
        return;
      }

      if (result.kind === "timeout") {
        proc.kill("SIGKILL");
        throw new Error("Kokoro server did not become healthy within 60 s");
      }

      const providerNote = await this.#alignProvider(runtime, signal, false);
      if (signal.aborted) {
        await stop();
        return;
      }

      this.#set({ state: "running", detail: providerNote });

      const code = await proc.exited;
      if (signal.aborted) return;
      throw new Error(`Kokoro server exited with code ${code}`);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** A server already answers at the URL: use it, after making sure it synthesizes by itself. */
  async #adopt(signal: AbortSignal): Promise<void> {
    const note = await this.#alignProvider(this.#deps.prefs().runtime, signal, true);
    if (signal.aborted) return;
    return this.#watchExternal(signal, note);
  }

  /**
   * Matches the engine provider to the runtime: the GPU runtime switches a
   * "cpu" engine to "cuda" when CUDA is usable, the CPU runtime switches a
   * "cuda" engine back to "cpu". A "remote" engine (it forwards to another
   * server, which the plugin's engine slots do not allow) always switches to
   * the runtime's provider, also on a server bb did not start (`adopted`),
   * which is otherwise left as it is. "openvino" is the user's explicit
   * choice and never touched. Returns a note for the Server card when the
   * switch failed, else null.
   */
  async #alignProvider(runtime: "cpu" | "gpu", signal: AbortSignal, adopted: boolean): Promise<string | null> {
    try {
      const { provider, cudaAvailable } = await this.#deps.engineProvider(signal);
      const own = runtime === "gpu" && cudaAvailable ? "cuda" : "cpu";
      if (provider === "remote") await this.#deps.setProvider(own, signal);
      else if (adopted) return null;
      else if (runtime === "gpu" && provider === "cpu" && cudaAvailable) await this.#deps.setProvider("cuda", signal);
      else if (runtime === "cpu" && provider === "cuda") await this.#deps.setProvider("cpu", signal);
      return null;
    } catch (cause) {
      if (signal.aborted) return null;
      return `Could not switch the engine provider: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  /** SIGTERM, then SIGKILL after a 5 s grace period; resolves once the process has exited. */
  async #stopProc(proc: ServerProcess): Promise<void> {
    proc.kill("SIGTERM");
    const t = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    try {
      await proc.exited;
    } finally {
      clearTimeout(t);
    }
  }

  async #waitHealthy(proc: ServerProcess, signal: AbortSignal): Promise<
    { kind: "healthy" } | { kind: "exited"; code: number | string | null } | { kind: "timeout" }
  > {
    let exited: { code: number | string | null } | null = null;
    void proc.exited.then((code) => { exited = { code }; });
    const deadline = this.#deps.now() + 60_000;
    while (!signal.aborted && !exited && this.#deps.now() < deadline) {
      if (await this.#deps.health()) return { kind: "healthy" };
      if (exited) break;
      await this.#deps.sleep(500, signal);
    }
    // `exited` is reassigned from a closure across awaits, so TS can't narrow it here.
    if (exited) return { kind: "exited", code: (exited as { code: number | string | null }).code };
    return { kind: "timeout" };
  }

  async #watchExternal(signal: AbortSignal, detail: string | null = null): Promise<void> {
    this.#set({ state: "external", detail, progress: null, fixCommand: null });
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      await this.#deps.sleep(10_000, signal);
      if (signal.aborted) return;
      if (await this.#deps.health()) {
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) throw new Error("Kokoro server stopped responding");
    }
  }
}
