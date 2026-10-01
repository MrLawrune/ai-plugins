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
  const chain = new EngineChain({ engines: () => ({ main, backup }), firstFrameMs: 50 });
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
test("cold health selects the long first-frame timeout", async () => {
  const slow = (_c: string, signal: AbortSignal) => (async function* () {
    await new Promise((res, rej) => { const t = setTimeout(res, 60); signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }); });
    yield frame(1);
  })();
  const main = engine("m", slow);
  const chain = new EngineChain({ engines: () => ({ main, backup: null }), firstFrameMs: 20, firstFrameColdMs: 1000 });
  chain.noteHealth("main", { reachable: true, loaded: false, version: null, forwards: false, error: null });
  assert.equal((await collect(chain.synthesize("Hi.", OPTS, new AbortController().signal))).length, 1);
  chain.reset();
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
