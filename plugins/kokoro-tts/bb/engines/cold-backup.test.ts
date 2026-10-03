import { test } from "node:test";
import assert from "node:assert/strict";
import type { SetupState } from "../schemas.ts";
import { EngineChain } from "./chain.ts";
import { COLD_IDLE_MS, ColdBackup, type ColdBackupDeps } from "./cold-backup.ts";
import { EngineError, type Engine, type EngineHealth, type Pcm } from "./types.ts";

const OPTS = { voice: "af_sky", speed: 1, lang: "en-us", trim: true, leadInMs: 0, gapMs: 0 };
const UP: EngineHealth = { reachable: true, loaded: true, version: null, forwards: false, error: null };
const DOWN: EngineHealth = { reachable: false, loaded: null, version: null, forwards: null, error: "ECONNREFUSED" };
const MIN = 60_000;

/** The supervisor's cold-backup surface: a stopped server, started by demand(), answering once `answer()` is called. */
function fakeSupervisor() {
  let state: SetupState["state"] = "standby";
  let demanded = false;
  let waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const events: string[] = [];
  const settle = (e: Error | null) => {
    for (const w of waiters.splice(0)) (e ? w.reject(e) : w.resolve());
  };
  return {
    events,
    status: () => ({ state }),
    demanded: () => demanded,
    demand: () => {
      if (demanded) return;
      demanded = true;
      state = "starting";
      events.push("demand");
    },
    release: () => {
      if (!demanded) return;
      demanded = false;
      state = "standby";
      events.push("release");
      settle(new Error("the local server was stopped"));
    },
    ready: () => (state === "running"
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => { waiters.push({ resolve, reject }); })),
    answer: () => { state = "running"; settle(null); },
    fail: (message: string) => { demanded = false; state = "standby"; settle(new Error(message)); },
  };
}

function cold(over: Partial<ColdBackupDeps> & { sup?: ReturnType<typeof fakeSupervisor> } = {}) {
  const sup = over.sup ?? fakeSupervisor();
  let t = 0;
  let main = UP;
  const probes: number[] = [];
  const back: EngineHealth[] = [];
  const backup = new ColdBackup({
    supervisor: () => sup,
    mainHealth: async () => { probes.push(t); return main; },
    mainBack: (h) => { back.push(h); },
    now: () => t,
    ...over,
  });
  return {
    backup, sup, probes, back,
    at: (ms: number) => { t = ms; },
    setMain: (h: EngineHealth) => { main = h; },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const signal = () => new AbortController().signal;

test("a stopped backup is started once for concurrent replies, and reported freshly started", async () => {
  const { backup, sup } = cold();
  const a = backup.ensure(signal());
  const b = backup.ensure(signal());
  await tick();
  assert.deepEqual(sup.events, ["demand"]);
  sup.answer();
  assert.deepEqual(await Promise.all([a, b]), ["started", "started"]);
});

test("a running backup is used at once, without another start", async () => {
  const { backup, sup } = cold();
  sup.demand();
  sup.answer();
  assert.equal(await backup.ensure(signal()), undefined);
  assert.deepEqual(sup.events, ["demand"]);
});

test("a start that does not answer within its budget fails the attempt", async () => {
  const { backup } = cold({ startMs: 20 });
  await assert.rejects(backup.ensure(signal()), /the local server did not start within 0\.02 s/);
});

test("a failed start fails the attempt with the reason", async () => {
  const { backup, sup } = cold();
  const p = backup.ensure(signal());
  await tick();
  sup.fail("Kokoro server exited with code 1 during startup");
  await assert.rejects(p, /exited with code 1 during startup/);
});

test("no installed server: the attempt fails", async () => {
  const { backup } = cold({ supervisor: () => null });
  await assert.rejects(backup.ensure(signal()), /not installed/);
});

test("cool-down: main healthy and the backup unused for 10 minutes stops it", async () => {
  const { backup, sup, at, back } = cold();
  const started = backup.ensure(signal());
  sup.answer();
  await started;
  at(COLD_IDLE_MS - 1);
  await backup.check(signal());
  assert.deepEqual(sup.events, ["demand"], "not before 10 minutes");
  assert.equal(back.length, 1, "main is back: replies return to it");
  at(COLD_IDLE_MS);
  await backup.check(signal());
  assert.deepEqual(sup.events, ["demand", "release"]);
});

test("cool-down waits while the main server is still down", async () => {
  const { backup, sup, at, back, setMain } = cold();
  const started = backup.ensure(signal());
  sup.answer();
  await started;
  setMain(DOWN);
  at(30 * MIN);
  await backup.check(signal());
  assert.deepEqual(sup.events, ["demand"]);
  assert.deepEqual(back, []);
  setMain({ ...UP, forwards: true });
  await backup.check(signal());
  assert.deepEqual(sup.events, ["demand"], "a forwarding main server cannot speak");
});

test("a reply on the backup within the window postpones the cool-down", async () => {
  const { backup, sup, at } = cold();
  const started = backup.ensure(signal());
  sup.answer();
  await started;
  at(5 * MIN);
  for await (const _ of backup.serve((used) => (async function* () { used(); yield new Uint8Array(4); })()));
  at(10 * MIN);
  await backup.check(signal());
  assert.deepEqual(sup.events, ["demand"]);
  at(15 * MIN);
  await backup.check(signal());
  assert.deepEqual(sup.events, ["demand", "release"]);
});

test("the backup is never stopped mid-reply", async () => {
  const { backup, sup, at } = cold();
  const started = backup.ensure(signal());
  sup.answer();
  await started;
  let finish!: () => void;
  const playing = (async () => {
    for await (const _ of backup.serve((used) => (async function* (): AsyncGenerator<Pcm> {
      used();
      yield new Uint8Array(4);
      await new Promise<void>((r) => { finish = r; });
    })()));
  })();
  await tick();
  at(60 * MIN);
  await backup.check(signal());
  assert.deepEqual(sup.events, ["demand"], "a reply is still being spoken");
  finish();
  await playing;
  at(60 * MIN + COLD_IDLE_MS);
  await backup.check(signal());
  assert.deepEqual(sup.events, ["demand", "release"]);
});

test("a reply the main engine speaks does not keep the backup running", async () => {
  const { backup, sup, at } = cold();
  const started = backup.ensure(signal());
  sup.answer();
  await started;
  at(9 * MIN);
  for await (const _ of backup.serve(() => (async function* () { yield new Uint8Array(4); })()));
  at(COLD_IDLE_MS);
  await backup.check(signal());
  assert.deepEqual(sup.events, ["demand", "release"]);
});

test("a stopped backup is left alone: no health checks of the main server", async () => {
  const { backup, sup, probes } = cold();
  await backup.check(signal());
  assert.deepEqual(probes, []);
  assert.deepEqual(sup.events, []);
});

test("the cool-down checks every minute until stopped", async () => {
  const slept: number[] = [];
  const ac = new AbortController();
  const { backup, sup } = cold({
    sleep: async (ms) => { slept.push(ms); if (slept.length === 3) ac.abort(); },
  });
  let checks = 0;
  backup.check = async () => { checks++; };
  sup.demand();
  await backup.watch(ac.signal);
  assert.deepEqual(slept, [MIN, MIN, MIN]);
  assert.equal(checks, 2);
});

// --- with the chain: main down, the cold backup is started and speaks ---

function engine(url: string, behave: () => AsyncIterable<Pcm>): Engine & { calls: number } {
  const e = {
    url, calls: 0,
    health: async () => UP,
    voices: async () => [],
    synthesize: () => { e.calls++; return behave(); },
  };
  return e;
}
const down = () => (async function* (): AsyncGenerator<Pcm> { throw new EngineError("unreachable", "connect ECONNREFUSED"); })();
async function collect(it: AsyncIterable<Pcm>) { const out: Pcm[] = []; for await (const f of it) out.push(f); return out; }

test("main unreachable: the cold backup is started and speaks the replies, one start for all of them", async () => {
  const { backup: coldBackup, sup } = cold();
  const main = engine("http://gpu", down);
  const local = engine("http://127.0.0.1:6789", () => (async function* () { yield new Uint8Array(40); })());
  const chain = new EngineChain({
    engines: () => ({ main, backup: local }),
    prepare: (slot, s) => (slot === "backup" ? coldBackup.ensure(s) : undefined),
  });
  const used: string[] = [];
  const replies = [1, 2, 3].map(() => collect(chain.synthesize("Hi.", OPTS, signal(), (slot) => used.push(slot))));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(local.calls, 0, "not before the server answers");
  sup.answer();
  const out = await Promise.all(replies);
  assert.deepEqual(out.map((frames) => frames.length), [1, 1, 1]);
  assert.deepEqual(used, ["backup", "backup", "backup"]);
  assert.deepEqual(sup.events, ["demand"]);
});

test("main unreachable and the cold backup does not start: the reply fails as unreachable", async () => {
  const { backup: coldBackup } = cold({ startMs: 20 });
  const main = engine("http://gpu", down);
  const local = engine("http://127.0.0.1:6789", () => (async function* () { yield new Uint8Array(40); })());
  const chain = new EngineChain({
    engines: () => ({ main, backup: local }),
    prepare: (slot, s) => (slot === "backup" ? coldBackup.ensure(s) : undefined),
  });
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, signal())),
    (e: EngineError) => e.kind === "unreachable" && /^unreachable: the local server did not start within/.test(e.message));
  assert.equal(local.calls, 0);
});

test("unloading fails a pending start at once and leaves no timer behind", async () => {
  const { backup } = cold({ startMs: 60 * MIN });
  const p = backup.ensure(signal());
  backup.dispose();
  await assert.rejects(p, /unloading/);
  const after = backup.ensure(signal());
  await assert.rejects(after, /unloading/);
});
