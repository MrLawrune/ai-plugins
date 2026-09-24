import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS } from "./prefs.ts";
import type { Prefs } from "./schemas.ts";
import { Supervisor, type ServerProcess, type SupervisorDeps } from "./supervisor.ts";

function fakeProc() {
  let resolveExit!: (code: number | null) => void;
  const kills: string[] = [];
  const proc: ServerProcess & { kills: string[]; exit: (c: number | null) => void } = {
    exited: new Promise((r) => { resolveExit = r; }),
    kill: (s) => { kills.push(s); resolveExit(null); },
    kills,
    exit: (c) => resolveExit(c),
  };
  return proc;
}

function deps(over: Omit<Partial<SupervisorDeps>, "prefs"> & { healthSeq?: boolean[]; prefs?: Partial<Prefs> } = {}) {
  const log: string[] = [];
  // Pull the merge-only keys (healthSeq, prefs) out before spreading the rest,
  // so a `prefs: {...}` override merges into DEFAULT_PREFS instead of clobbering
  // the `prefs()` function below with a plain object.
  const { healthSeq: healthSeqOverride, prefs: prefsOverride, ...rest } = over;
  const healthSeq = [...(healthSeqOverride ?? [false, true])];
  const procs: ReturnType<typeof fakeProc>[] = [];
  let t = 0;
  const d: SupervisorDeps = {
    health: async () => (healthSeq.length > 1 ? healthSeq.shift()! : healthSeq[0]),
    prefs: () => ({ ...DEFAULT_PREFS, ...prefsOverride }),
    serverUrl: () => "http://127.0.0.1:6789",
    findUv: () => "/usr/bin/uv",
    ensureModels: async (p) => { log.push("models"); p(1); },
    syncRuntime: async (_uv, rt) => { log.push(`sync:${rt}`); },
    probeAudio: async () => true,
    spawnServer: (o) => { log.push(`spawn:${o.runtime}:${o.headless}`); const p = fakeProc(); procs.push(p); return p; },
    gpuAvailable: () => false,
    engineProvider: async () => ({ provider: "cpu", cudaAvailable: false }),
    setProvider: async (p) => { log.push(`provider:${p}`); },
    sleep: async () => { t += 500; await new Promise((r) => setImmediate(r)); },
    now: () => t,
    ...rest,
  };
  return { d, log, procs };
}

const until = async (pred: () => boolean) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setImmediate(r)); };

test("adopts a server that already answers", async () => {
  const { d, log } = deps({ healthSeq: [true] });
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => sup.status().state === "external");
  assert.equal(sup.status().state, "external");
  assert.deepEqual(log, []);
  ctl.abort();
  await run;
});

test("full managed setup reaches running, then stops the server on abort", async () => {
  const { d, log, procs } = deps();
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => sup.status().state === "running");
  assert.deepEqual(log, ["models", "sync:cpu", "spawn:cpu:false"]);
  ctl.abort();
  await run;
  assert.deepEqual(procs[0].kills, ["SIGTERM"]);
});

test("no audio output spawns headless", async () => {
  const { d, log } = deps({ probeAudio: async () => false });
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => sup.status().state === "running");
  assert.equal(log.at(-1), "spawn:cpu:true");
  assert.equal(sup.status().headless, true);
  ctl.abort();
  await run;
});

test("waits in needs-uv until uv is installed", async () => {
  let uv: string | null = null;
  const { d, log } = deps({ findUv: () => uv });
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => sup.status().state === "needs-uv");
  assert.match(sup.status().fixCommand ?? "", /astral\.sh/);
  uv = "/h/.local/bin/uv";
  sup.uvInstalled();
  await until(() => sup.status().state === "running");
  assert.ok(log.includes("models"));
  ctl.abort();
  await run;
});

test("unmanaged and unreachable shows an error without spawning", async () => {
  const { d, log } = deps({ healthSeq: [false], prefs: { manageServer: false } });
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => sup.status().state === "error");
  assert.match(sup.status().detail ?? "", /not reachable/);
  assert.deepEqual(log, []);
  ctl.abort();
  await run;
});

test("a crash rejects so BB restarts the service", async () => {
  const { d, procs } = deps();
  const sup = new Supervisor(d);
  const run = sup.start(new AbortController().signal);
  await until(() => sup.status().state === "running");
  procs[0].exit(1);
  await assert.rejects(run, /exited with code 1/);
  assert.equal(sup.status().state, "error");
});

test("setup errors surface their fix command", async () => {
  const { SetupError } = await import("./setup/errors.ts");
  const { d } = deps({ syncRuntime: async () => { throw new SetupError("Runtime install failed: boom", "uv sync ..."); } });
  const sup = new Supervisor(d);
  await assert.rejects(sup.start(new AbortController().signal), /boom/);
  assert.deepEqual([sup.status().state, sup.status().fixCommand], ["error", "uv sync ..."]);
});

test("restart kills the managed server and runs setup again", async () => {
  let runtime: "cpu" | "gpu" = "cpu";
  const { d, log, procs } = deps({ healthSeq: [false, true, false, true], prefs: {} });
  d.prefs = () => ({ ...DEFAULT_PREFS, runtime });
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => sup.status().state === "running");
  runtime = "gpu";
  sup.restart();
  await until(() => log.includes("spawn:gpu:false"));
  assert.deepEqual(procs[0].kills, ["SIGTERM"]);
  ctl.abort();
  await run;
});

test("abort during the final health check still stops the server instead of hanging", async () => {
  // health() blocks past the adopt check until the test releases it -- simulating
  // an abort landing while the last (successful) health probe is still in flight.
  let releaseHealthy: () => void = () => {};
  const healthyGate = new Promise<void>((resolve) => { releaseHealthy = resolve; });
  let adopted = false;
  const { d, procs } = deps({
    health: async () => {
      if (!adopted) {
        adopted = true;
        return false;
      }
      await healthyGate;
      return true;
    },
  });
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => sup.status().state === "starting");
  ctl.abort();
  releaseHealthy();
  await run; // must resolve, not hang
  assert.deepEqual(procs[0].kills, ["SIGTERM"]);
  assert.notEqual(sup.status().state, "running");
});

test("a crash during startup is reported with its exit code, not a generic timeout", async () => {
  const { d, procs } = deps({ healthSeq: [false] });
  const sup = new Supervisor(d);
  const run = sup.start(new AbortController().signal);
  await until(() => procs.length > 0);
  procs[0].exit(1);
  await assert.rejects(run, /exited with code 1 during startup/);
  assert.equal(sup.status().state, "error");
});

test("a single failed health check on an external server does not trigger a managed takeover", async () => {
  const seq = [true, false, true, true, true];
  let i = 0;
  const { d, log } = deps({ health: async () => seq[Math.min(i++, seq.length - 1)] });
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => i >= 4);
  assert.equal(sup.status().state, "external");
  assert.deepEqual(log, []);
  ctl.abort();
  await run;
});

test("three consecutive failed health checks on an external server reports it stopped", async () => {
  const { d } = deps({ healthSeq: [true, false, false, false] });
  const sup = new Supervisor(d);
  const run = sup.start(new AbortController().signal);
  await until(() => sup.status().state === "external");
  await assert.rejects(run, /stopped responding/);
  assert.equal(sup.status().state, "error");
});

async function runUntilRunning(over: Parameters<typeof deps>[0]) {
  const { d, log } = deps(over);
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => sup.status().state === "running");
  ctl.abort();
  await run;
  return { log: log.filter((l) => l.startsWith("provider:")), status: sup.status() };
}

test("GPU runtime switches a cpu engine to cuda when CUDA is available", async () => {
  const { log } = await runUntilRunning({
    prefs: { runtime: "gpu" },
    engineProvider: async () => ({ provider: "cpu", cudaAvailable: true }),
  });
  assert.deepEqual(log, ["provider:cuda"]);
});

test("GPU runtime leaves the engine alone when CUDA is not available", async () => {
  const { log } = await runUntilRunning({
    prefs: { runtime: "gpu" },
    engineProvider: async () => ({ provider: "cpu", cudaAvailable: false }),
  });
  assert.deepEqual(log, []);
});

test("CPU runtime switches a cuda engine back to cpu", async () => {
  const { log } = await runUntilRunning({
    prefs: { runtime: "cpu" },
    engineProvider: async () => ({ provider: "cuda", cudaAvailable: false }),
  });
  assert.deepEqual(log, ["provider:cpu"]);
});

test("remote and openvino providers are never touched", async () => {
  for (const runtime of ["cpu", "gpu"] as const) {
    for (const provider of ["remote", "openvino"]) {
      const { log } = await runUntilRunning({
        prefs: { runtime },
        engineProvider: async () => ({ provider, cudaAvailable: true }),
      });
      assert.deepEqual(log, [], `${runtime}/${provider}`);
    }
  }
});

test("a failed provider switch still runs and explains why on the card", async () => {
  const { status } = await runUntilRunning({
    prefs: { runtime: "gpu" },
    engineProvider: async () => ({ provider: "cpu", cudaAvailable: true }),
    setProvider: async () => { throw new Error("engine change failed"); },
  });
  assert.match(status.detail ?? "", /Could not switch the engine provider: engine change failed/);
});

test("the provider is not aligned for an adopted external server", async () => {
  let asked = false;
  const { d } = deps({ healthSeq: [true], engineProvider: async () => { asked = true; return { provider: "cpu", cudaAvailable: true }; } });
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => sup.status().state === "external");
  ctl.abort();
  await run;
  assert.equal(asked, false);
});

test("a failed uv install shows the installer error and the manual command while waiting", async () => {
  let uv: string | null = null;
  const { d } = deps({ findUv: () => uv });
  const sup = new Supervisor(d);
  const ctl = new AbortController();
  const run = sup.start(ctl.signal);
  await until(() => sup.status().state === "needs-uv");
  sup.uvInstallFailed("the installer exited with code 1 (curl: could not resolve host).");
  assert.equal(sup.status().state, "needs-uv");
  assert.match(sup.status().detail ?? "", /Installing uv failed: the installer exited with code 1 \(curl: could not resolve host\)\./);
  assert.match(sup.status().fixCommand ?? "", /astral\.sh/);
  // The needs-uv loop re-checks uv every few seconds; the failure must stay visible.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.match(sup.status().detail ?? "", /Installing uv failed/);
  uv = "/h/.local/bin/uv";
  sup.uvInstalled();
  await until(() => sup.status().state === "running");
  ctl.abort();
  await run;
});
