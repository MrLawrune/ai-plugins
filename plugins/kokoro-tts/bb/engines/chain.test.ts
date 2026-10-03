import { test } from "node:test";
import assert from "node:assert/strict";
import { EngineChain } from "./chain.ts";
import { EngineError, type Engine, type Pcm } from "./types.ts";

const OPTS = { voice: "af_sky", speed: 1, lang: "en-us", trim: true, leadInMs: 0, gapMs: 0 };
const frame = (n: number) => new Uint8Array(4 * n);
function engine(url: string, behave: (chunk: string, signal: AbortSignal) => AsyncIterable<Pcm>): Engine & { calls: string[] } {
  const calls: string[] = [];
  return {
    url, calls,
    health: async () => ({ reachable: true, loaded: true, version: null, forwards: false, error: null }),
    voices: async () => [],
    synthesize: (chunk, _o, signal) => { calls.push(chunk); return behave(chunk, signal); },
  };
}
const ok = () => (async function* () { yield frame(10); })();
const fail = (kind: "unreachable" | "config") => (async function* (): AsyncGenerator<Pcm> { throw new EngineError(kind, kind); })();
const hang = (_c: string, signal: AbortSignal) => (async function* (): AsyncGenerator<Pcm> {
  await new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
})();
async function collect(it: AsyncIterable<Pcm>) { const out: Pcm[] = []; for await (const f of it) out.push(f); return out; }

test("main ok: backup never called", async () => {
  const main = engine("m", ok); const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }) });
  const used: string[] = [];
  await collect(chain.synthesize("Hello.", OPTS, new AbortController().signal, (s) => used.push(s)));
  assert.deepEqual(used, ["main"]); assert.equal(backup.calls.length, 0);
});
test("main unreachable: backup speaks and the breaker opens", async () => {
  const main = engine("m", () => fail("unreachable")); const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }) });
  const used: string[] = [];
  await collect(chain.synthesize("Hello.", OPTS, new AbortController().signal, (s) => used.push(s)));
  assert.deepEqual(used, ["backup"]); assert.equal(chain.breaker().state, "open");
});
test("main hangs: backup answers within the first-frame budget", async () => {
  const main = engine("m", hang); const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }), firstFrameMs: 50, firstFrameColdMs: 50 });
  const t0 = Date.now();
  const frames = await collect(chain.synthesize("Hello.", OPTS, new AbortController().signal));
  assert.equal(frames.length, 1); assert.ok(Date.now() - t0 < 1000);
});
test("config error: backup used, breaker stays closed", async () => {
  const main = engine("m", () => fail("config")); const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }) });
  await collect(chain.synthesize("Hello.", OPTS, new AbortController().signal));
  assert.equal(chain.breaker().state, "closed");
});
test("abort is not a failure", async () => {
  const main = engine("m", hang); const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }), firstFrameMs: 5000 });
  const ac = new AbortController(); setTimeout(() => ac.abort(), 20);
  await assert.rejects(collect(chain.synthesize("Hello.", OPTS, ac.signal)), (e: EngineError) => e.kind === "cancelled");
  assert.equal(backup.calls.length, 0); assert.equal(chain.breaker().state, "closed");
});
test("failure after first audio ends the reply without switching", async () => {
  let n = 0;
  const main = engine("m", () => (n++ === 0 ? ok() : fail("unreachable"))); const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }) });
  await assert.rejects(collect(chain.synthesize("One. Two. " + "x".repeat(230) + ".", OPTS, new AbortController().signal)), (e: EngineError) => e.kind === "stream");
  assert.equal(backup.calls.length, 0);
});
test("no backup and main down: throws unreachable", async () => {
  const main = engine("m", () => fail("unreachable"));
  const chain = new EngineChain({ engines: () => ({ main, backup: null }) });
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)), (e: EngineError) => e.kind === "unreachable");
});
test("open breaker skips main until cooldown, then half-open success closes it", async () => {
  let down = true; let t = 0;
  const main = engine("m", () => (down ? fail("unreachable") : ok())); const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }), now: () => t, cooldownMs: 1000 });
  await collect(chain.synthesize("A.", OPTS, new AbortController().signal));
  const before = main.calls.length;
  await collect(chain.synthesize("B.", OPTS, new AbortController().signal));
  assert.equal(main.calls.length, before);           // skipped while open
  down = false; t = 2000;
  await collect(chain.synthesize("C.", OPTS, new AbortController().signal));
  assert.equal(chain.breaker().state, "closed");
});
test("lead-in is prepended to the first engine frame, never yielded alone", async () => {
  const main = engine("m", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup: null }) });
  const frames = await collect(chain.synthesize("Hi.", { ...OPTS, leadInMs: 100 }, new AbortController().signal));
  assert.equal(frames.length, 1); assert.equal(frames[0].length, 2400 * 4 + 40);
});

// --- beyond the brief's list: invariants the hub relies on ---

test("unreachable errors carry the 'unreachable: ' prefix", async () => {
  const main = engine("m", hang);
  const chain = new EngineChain({ engines: () => ({ main, backup: null }), firstFrameMs: 20 });
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)), (e: EngineError) =>
    e.kind === "unreachable" && e.message.startsWith("unreachable: "));
  const down = engine("m", () => fail("unreachable"));
  const chain2 = new EngineChain({ engines: () => ({ main: down, backup: null }) });
  await assert.rejects(collect(chain2.synthesize("Hi.", OPTS, new AbortController().signal)), (e: EngineError) =>
    e.message.startsWith("unreachable: "));
});
test("only: uses exactly that slot and leaves the breaker alone", async () => {
  const main = engine("m", () => fail("unreachable")); const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }) });
  await assert.rejects(collect(chain.synthesize("Hi.", { ...OPTS, only: "main" }, new AbortController().signal)),
    (e: EngineError) => e.kind === "unreachable");
  assert.equal(backup.calls.length, 0); assert.equal(chain.breaker().state, "closed");
  const used: string[] = [];
  await collect(chain.synthesize("Hi.", { ...OPTS, only: "backup" }, new AbortController().signal, (s) => used.push(s)));
  assert.deepEqual(used, ["backup"]); assert.equal(main.calls.length, 1);
  const lone = new EngineChain({ engines: () => ({ main, backup: null }) });
  await assert.rejects(collect(lone.synthesize("Hi.", { ...OPTS, only: "backup" }, new AbortController().signal)),
    (e: EngineError) => e.kind === "config" && /no backup/.test(e.message));
});
test("gap silence leads each later chunk; empty text yields nothing", async () => {
  const main = engine("m", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup: null }) });
  const frames = await collect(chain.synthesize("One. " + "x".repeat(230) + ".", { ...OPTS, gapMs: 10 }, new AbortController().signal));
  assert.deepEqual(frames.map((f) => f.length), [40, 240 * 4 + 40]);
  assert.deepEqual(await collect(chain.synthesize("   ", OPTS, new AbortController().signal)), []);
});
test("a stall between frames throws stream 'engine stalled'", async () => {
  const main = engine("m", (_c, signal) => (async function* () {
    yield frame(1);
    await new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
  })());
  const chain = new EngineChain({ engines: () => ({ main, backup: null }), interFrameMs: 20 });
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)),
    (e: EngineError) => e.kind === "stream" && e.message === "engine stalled");
});
const slowFirst = (ms: number) => (_c: string, signal: AbortSignal) => (async function* () {
  await new Promise((res, rej) => { const t = setTimeout(res, ms); signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }); });
  yield frame(1);
})();
const COLD = { reachable: true, loaded: false, version: null, forwards: false, error: null };
const WARM = { ...COLD, loaded: true };

test("cold health selects the long first-frame timeout; audio makes the engine warm", async () => {
  const main = engine("m", slowFirst(60));
  const chain = new EngineChain({ engines: () => ({ main, backup: null }), firstFrameMs: 20, firstFrameColdMs: 1000 });
  chain.noteHealth("main", COLD, "m");
  assert.equal((await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal))).length, 1);
  // It just spoke, so its model is loaded: the short budget applies, and 60 ms is too slow.
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)), (e: EngineError) => e.kind === "unreachable");
});
test("an engine that has not spoken in 10 minutes gets the cold budget, even if health once said loaded", async () => {
  let t = 0;
  const main = engine("m", slowFirst(60));
  const chain = new EngineChain({ engines: () => ({ main, backup: null }), now: () => t, firstFrameMs: 20, firstFrameColdMs: 1000 });
  chain.noteHealth("main", WARM, "m");
  assert.equal((await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal))).length, 1, "never spoke here: cold");
  t += 9 * 60_000;
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)), (e: EngineError) => e.kind === "unreachable");
  chain.reset();
  chain.noteHealth("main", WARM, "m");
  await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal));
  t += 10 * 60_000; // a GPU engine may have unloaded since
  assert.equal((await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal))).length, 1);
});
test("an engine that unloads its model sooner than 10 minutes is cold after that many idle minutes", async () => {
  let t = 0;
  const main = engine("m", slowFirst(60));
  const chain = new EngineChain({ engines: () => ({ main, backup: null }), now: () => t, firstFrameMs: 20, firstFrameColdMs: 1000 });
  chain.noteHealth("main", { ...WARM, unloadAfterMs: 2 * 60_000 }, "m");
  await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal));
  t += 3 * 60_000; // unloaded a minute ago
  assert.equal((await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal))).length, 1, "cold budget");
  t += 60_000; // spoke just now: warm again
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)), (e: EngineError) => e.kind === "unreachable");
  chain.reset();
  chain.noteHealth("main", { ...WARM, unloadAfterMs: 60 * 60_000 }, "m");
  await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal));
  t += 10 * 60_000; // a longer idle unload is capped at 10 minutes
  assert.equal((await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal))).length, 1, "cold budget");
});

test("stale loaded:false health is replaced once the engine speaks", async () => {
  // The settings page saw the model unloaded once and then closed: later outages must not keep the 30 s budget.
  const t = 0;
  let mode: "slow" | "hang" = "slow";
  const main = engine("m", (c, s) => (mode === "slow" ? slowFirst(30)(c, s) : hang(c, s)));
  const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }), now: () => t, firstFrameMs: 50, firstFrameColdMs: 5000 });
  chain.noteHealth("main", COLD, "m");
  await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal));
  mode = "hang";
  const t0 = Date.now();
  const used: string[] = [];
  await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal, (s) => used.push(s)));
  assert.deepEqual(used, ["backup"]);
  assert.ok(Date.now() - t0 < 2000, "the short budget, not the cold one");
});
test("an engine whose last attempt went unanswered retries with the short budget", async () => {
  const main = engine("m", hang);
  const chain = new EngineChain({ engines: () => ({ main, backup: null }), firstFrameMs: 20, firstFrameColdMs: 300, cooldownMs: 0 });
  const t0 = Date.now();
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)));
  const cold = Date.now() - t0;
  assert.ok(cold >= 280, `first attempt used the cold budget (${cold} ms)`);
  const t1 = Date.now();
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)));
  assert.ok(Date.now() - t1 < 200, "the retry used the short budget");
});
test("an old main failing after the engines changed leaves the new configuration's breaker alone", async () => {
  let release: () => void = () => {};
  const oldMain = engine("old", () => (async function* (): AsyncGenerator<Pcm> {
    await new Promise<void>((r) => { release = r; });
    throw new EngineError("unreachable", "unreachable: connect ECONNREFUSED");
  })());
  const newMain = engine("new", ok);
  const backup = engine("b", ok);
  let main: Engine = oldMain;
  const chain = new EngineChain({ engines: () => ({ main, backup }) });
  const inflight = collect(chain.synthesize("Hi.", OPTS, new AbortController().signal));
  await new Promise((r) => setImmediate(r));
  main = newMain;
  chain.reset();
  release();
  await inflight; // the old reply still finishes, through the backup
  assert.deepEqual(chain.breaker(), { state: "closed", until: null });
  const used: string[] = [];
  await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal, (s) => used.push(s)));
  assert.deepEqual(used, ["main"]);
  assert.equal(newMain.calls.length, 1);
});
test("health for an engine no longer in its slot is ignored", async () => {
  const main = engine("new", slowFirst(60));
  const chain = new EngineChain({ engines: () => ({ main, backup: null }), firstFrameMs: 20, firstFrameColdMs: 1000 });
  await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)); // now warm
  chain.noteHealth("main", COLD, "old");
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)), (e: EngineError) => e.kind === "unreachable");
});
test("consumer return() closes the engine iterator", async () => {
  let closed = false;
  const main = engine("m", () => (async function* () {
    try { yield frame(1); yield frame(1); } finally { closed = true; }
  })());
  const chain = new EngineChain({ engines: () => ({ main, backup: null }) });
  const it = chain.synthesize("Hi.", OPTS, new AbortController().signal);
  await it.next();
  await it.return(undefined);
  assert.equal(closed, true);
});

// --- review fixes ---

test("a refused later chunk is a stream error without the 'unreachable: ' prefix", async () => {
  let n = 0;
  const main = engine("m", () => (n++ === 0 ? ok() : (async function* (): AsyncGenerator<Pcm> {
    throw new EngineError("unreachable", "unreachable: connect ECONNREFUSED 10.0.99.50:6789");
  })()));
  const chain = new EngineChain({ engines: () => ({ main, backup: null }) });
  await assert.rejects(collect(chain.synthesize("One. " + "x".repeat(230) + ".", OPTS, new AbortController().signal)), (e: EngineError) =>
    e.kind === "stream" && e.message === "engine failed mid-reply: connect ECONNREFUSED 10.0.99.50:6789");
});
test("main succeeding while the breaker is open (no backup) closes it", async () => {
  let down = true;
  const main = engine("m", () => (down ? fail("unreachable") : ok()));
  const chain = new EngineChain({ engines: () => ({ main, backup: null }), now: () => 0, cooldownMs: 1000 });
  await assert.rejects(collect(chain.synthesize("A.", OPTS, new AbortController().signal)));
  assert.equal(chain.breaker().state, "open");
  down = false;
  await collect(chain.synthesize("B.", OPTS, new AbortController().signal));
  assert.deepEqual(chain.breaker(), { state: "closed", until: null });
});
test("an already-aborted reply is cancelled at once even if the engine ignores its signal", async () => {
  const deaf = engine("m", () => (async function* (): AsyncGenerator<Pcm> { await new Promise(() => {}); })());
  const chain = new EngineChain({ engines: () => ({ main: deaf, backup: null }), firstFrameMs: 5000 });
  const ac = new AbortController(); ac.abort();
  const t0 = Date.now();
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, ac.signal)), (e: EngineError) => e.kind === "cancelled");
  assert.ok(Date.now() - t0 < 1000);
});
test("an engine whose synthesize throws synchronously still fails over", async () => {
  const main: Engine = { ...engine("m", ok), synthesize: () => { throw new EngineError("unreachable", "boom"); } };
  const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }) });
  const used: string[] = [];
  await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal, (s) => used.push(s)));
  assert.deepEqual(used, ["backup"]); assert.equal(chain.breaker().state, "open");
});
test("a stream failure before the first frame fails over with the breaker unchanged", async () => {
  const main = engine("m", () => (async function* (): AsyncGenerator<Pcm> { throw new EngineError("stream", "bad frame length 6"); })());
  const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }) });
  const used: string[] = [];
  await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal, (s) => used.push(s)));
  assert.deepEqual(used, ["backup"]); assert.equal(chain.breaker().state, "closed");
});

test("prepare runs before a slot is tried, only for slots that are tried", async () => {
  const prepared: string[] = [];
  const main = engine("m", ok); const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }), prepare: (slot) => { prepared.push(slot); } });
  await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal));
  assert.deepEqual(prepared, ["main"]);
});

test("a failed prepare fails that slot as unreachable without calling its engine", async () => {
  const main = engine("m", () => fail("unreachable")); const backup = engine("b", ok);
  const chain = new EngineChain({
    engines: () => ({ main, backup }),
    prepare: async (slot) => { if (slot === "backup") throw new Error("the local server did not start in time"); },
  });
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)),
    (e: EngineError) => e.kind === "unreachable" && e.message === "unreachable: the local server did not start in time");
  assert.equal(backup.calls.length, 0);
});

test("an engine prepare just started gets the warm first-frame budget", async () => {
  const main = engine("m", () => fail("unreachable")); const backup = engine("b", hang);
  const chain = new EngineChain({
    engines: () => ({ main, backup }), firstFrameMs: 50, firstFrameColdMs: 5_000,
    prepare: async (slot) => (slot === "backup" ? "started" : undefined),
  });
  const t0 = Date.now();
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, new AbortController().signal)), (e: EngineError) => e.kind === "unreachable");
  assert.ok(Date.now() - t0 < 1_000, `took ${Date.now() - t0} ms: a fresh server has its model loaded`);
});

test("a reply aborted while prepare waits is cancelled, not a failure", async () => {
  const main = engine("m", () => fail("unreachable")); const backup = engine("b", ok);
  const ac = new AbortController();
  const chain = new EngineChain({
    engines: () => ({ main, backup }),
    // A start that never ends: only the reply's abort gets the chain out of it.
    prepare: (slot) => (slot === "backup" ? new Promise<void>(() => { setTimeout(() => ac.abort(), 10); }) : undefined),
  });
  await assert.rejects(collect(chain.synthesize("Hi.", OPTS, ac.signal)), (e: EngineError) => e.kind === "cancelled");
  assert.equal(backup.calls.length, 0);
});

test("closing the breaker sends the next reply to main at once", async () => {
  let down = true;
  const main = engine("m", () => (down ? fail("unreachable") : ok())); const backup = engine("b", ok);
  const chain = new EngineChain({ engines: () => ({ main, backup }), cooldownMs: 60_000 });
  await collect(chain.synthesize("A.", OPTS, new AbortController().signal));
  assert.equal(chain.breaker().state, "open");
  down = false;
  chain.closeBreaker();
  const used: string[] = [];
  await collect(chain.synthesize("B.", OPTS, new AbortController().signal, (s) => used.push(s)));
  assert.deepEqual(used, ["main"]);
});
