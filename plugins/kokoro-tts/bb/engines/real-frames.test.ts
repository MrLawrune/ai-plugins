// Frame sizes recorded from the real Kokoro server, end to end: adapter -> chain -> hub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientRegistry } from "../clients.ts";
import { BACKSTOP_MS, MAX_FRAME_BYTES, PlayerHub, type EntryStatus, type SocketLike } from "../hub.ts";
import { EngineChain, FIRST_FRAME_COLD_MS, FIRST_FRAME_MS, type ReplyOpts } from "./chain.ts";
import { COLD_START_MS, ColdBackup } from "./cold-backup.ts";
import { createKokoroEngine } from "./kokoro.ts";
import { MAX_PIECE_BYTES, type Engine, type Pcm } from "./types.ts";

// Recorded: 452 characters, no sentence break, speed 1 -> 2,437,120 bytes;
// 212 characters at speed 0.5 -> 2,328,576; 221 characters at speed 0.7 -> 1,918,976.
const LONG = 2_437_120;
const SLOW = 2_328_576;

const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
/** A v2 /synthesize body: each frame filled with its index + 1, then the end marker. */
function body(sizes: number[]): ReadableStream<Uint8Array> {
  const parts: Uint8Array[] = [];
  sizes.forEach((n, i) => { parts.push(u32le(n), new Uint8Array(n).fill(i + 1)); });
  parts.push(u32le(0));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= all.length) { c.close(); return; }
      c.enqueue(all.slice(at, at + 65_536));
      at += 65_536;
    },
  });
}
const serving = (sizes: number[]) => (async () =>
  new Response(body(sizes), { status: 200, headers: { "X-Kokoro-Frames": "2" } })) as typeof fetch;

const OPTS: ReplyOpts = { voice: "af_sky", speed: 1, lang: "en-us", trim: true, leadInMs: 0, gapMs: 0 };
const SILENCE_BYTES = (ms: number) => Math.round((24_000 * ms) / 1000) * 4;

async function collect(it: AsyncIterable<Pcm>) { const out: Pcm[] = []; for await (const f of it) out.push(f); return out; }

test("a 2.4 MB model frame comes out of the chain in pieces of at most 1 MiB", async () => {
  const chain = new EngineChain({ engines: () => ({ main: createKokoroEngine("http://m", serving([LONG])), backup: null }) });
  const out = await collect(chain.synthesize("A long sentence.", OPTS, new AbortController().signal));
  assert.ok(out.every((p) => p.length <= MAX_PIECE_BYTES && p.length % 4 === 0));
  assert.equal(out.reduce((n, p) => n + p.length, 0), LONG);
  assert.equal(out.length, 3);
});

test("lead-in on a near-cap frame: silence leads the first piece, never alone", async () => {
  const near = MAX_PIECE_BYTES - 4;
  const lead = 300;
  const chain = new EngineChain({ engines: () => ({ main: createKokoroEngine("http://m", serving([near])), backup: null }) });
  const out = await collect(chain.synthesize("Hi.", { ...OPTS, leadInMs: lead }, new AbortController().signal));
  assert.ok(out.every((p) => p.length <= MAX_PIECE_BYTES));
  assert.equal(out.reduce((n, p) => n + p.length, 0), near + SILENCE_BYTES(lead));
  // The first piece is the silence and then engine audio (filled with 1s).
  assert.equal(out[0].length, MAX_PIECE_BYTES);
  assert.ok(out[0].subarray(0, SILENCE_BYTES(lead)).every((b) => b === 0));
  assert.equal(out[0][SILENCE_BYTES(lead)], 1);
});

test("gap silence between chunks stays attached to the next chunk's audio", async () => {
  const gap = 1000;
  let call = 0;
  const fake = (async () => {
    call++;
    return new Response(body([call === 1 ? 400 : MAX_PIECE_BYTES]), { status: 200, headers: { "X-Kokoro-Frames": "2" } });
  }) as typeof fetch;
  const chain = new EngineChain({ engines: () => ({ main: createKokoroEngine("http://m", fake), backup: null }) });
  const text = `${"a".repeat(150)}. ${"b".repeat(150)}.`;
  const out = await collect(chain.synthesize(text, { ...OPTS, gapMs: gap }, new AbortController().signal));
  assert.equal(call, 2);
  assert.deepEqual(out.map((p) => p.length), [400, MAX_PIECE_BYTES, SILENCE_BYTES(gap)]);
  assert.ok(out[1].subarray(0, SILENCE_BYTES(gap)).every((b) => b === 0));
  assert.equal(out[1][SILENCE_BYTES(gap)], 1);
});

class FakeSocket implements SocketLike {
  frames: Uint8Array[] = [];
  json: { type: string }[] = [];
  send(d: string | Uint8Array) { if (typeof d === "string") this.json.push(JSON.parse(d)); else this.frames.push(d); }
  close() {}
}

for (const [name, size, speed] of [["normal speed", LONG, 1], ["slow speed", SLOW, 0.5]] as const) {
  test(`chain -> hub plays a recorded ${size}-byte frame (${name}) with lead-in`, async () => {
    const chain = new EngineChain({ engines: () => ({ main: createKokoroEngine("http://m", serving([size])), backup: null }) });
    const statuses: [number, EntryStatus, unknown][] = [];
    const hub = new PlayerHub({
      registry: new ClientRegistry(),
      routing: () => ({ playOn: "follow", pinnedDevice: null }),
      synthesize: (text, signal) => chain.synthesize(text, { ...OPTS, speed, leadInMs: 2000 }, signal),
      reportStatus: async (id, s, extra) => { statuses.push([id, s, extra]); },
    });
    try {
      const sock = new FakeSocket();
      hub.onMessage(sock, JSON.stringify({ type: "hello", clientId: "c", deviceName: "c", focusedAt: 1, audioUnlocked: true }));
      hub.speak(7, "A long sentence.", "t1", 1);
      for (let i = 0; i < 50 && !sock.json.some((m) => m.type === "end"); i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(sock.json.some((m) => m.type === "end"), "the reply ended");
      assert.equal(statuses.length, 0);
      // Each binary message is a 4-byte entry id plus at most one piece.
      assert.ok(sock.frames.length >= 3);
      assert.ok(sock.frames.every((f) => f.length - 4 <= MAX_FRAME_BYTES));
      hub.onMessage(sock, JSON.stringify({ type: "status", entryId: 7, status: "playing", firstAudioMs: 1 }));
      hub.onMessage(sock, JSON.stringify({ type: "status", entryId: 7, status: "done" }));
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(statuses.map(([, s]) => s), ["playing", "done"]);
    } finally {
      hub.dispose();
    }
  });
}

test("two cold engines: the backup's audio near the end of its 30 s still plays through the hub", async (t) => {
  assert.ok(BACKSTOP_MS >= 2 * FIRST_FRAME_COLD_MS + 10_000, "the hub backstop leaves room for attempt cleanup");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cold = { reachable: true, loaded: false, version: null, forwards: false, error: null };
  const base = { health: async () => cold, voices: async () => [] };
  const main: Engine = {
    ...base, url: "http://main",
    synthesize: (_c, _o, signal) => (async function* (): AsyncGenerator<Pcm> {
      await new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
    })(),
  };
  const backup: Engine = {
    ...base, url: "http://backup",
    synthesize: () => (async function* (): AsyncGenerator<Pcm> {
      await new Promise((r) => setTimeout(r, FIRST_FRAME_COLD_MS - 100));
      yield new Uint8Array(400);
    })(),
  };
  const chain = new EngineChain({ engines: () => ({ main, backup }) });
  chain.noteHealth("main", cold, main.url);
  chain.noteHealth("backup", cold, backup.url);
  const statuses: [number, EntryStatus, unknown][] = [];
  const hub = new PlayerHub({
    registry: new ClientRegistry(),
    routing: () => ({ playOn: "follow", pinnedDevice: null }),
    synthesize: (text, signal) => chain.synthesize(text, OPTS, signal),
    reportStatus: async (id, s, extra) => { statuses.push([id, s, extra]); },
  });
  try {
    const sock = new FakeSocket();
    hub.onMessage(sock, JSON.stringify({ type: "hello", clientId: "c", deviceName: "c", focusedAt: 1, audioUnlocked: true }));
    hub.speak(7, "Hi.", "t1", 1);
    for (let ms = 0; ms < 2 * FIRST_FRAME_COLD_MS && !sock.json.some((m) => m.type === "end"); ms += 100) {
      t.mock.timers.tick(100);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    }
    assert.ok(sock.json.some((m) => m.type === "end"), JSON.stringify(sock.json));
    assert.equal(sock.frames.length, 1);
    assert.equal(statuses.length, 0);
  } finally {
    hub.dispose();
  }
});

test("a cold main, then a cold backup's whole start: its first audio still plays through the hub", async (t) => {
  assert.ok(BACKSTOP_MS >= FIRST_FRAME_COLD_MS + COLD_START_MS + FIRST_FRAME_MS + 10_000,
    "the hub backstop covers the main's cold budget, the backup's start, its warm budget and attempt cleanup");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cold = { reachable: true, loaded: false, version: null, forwards: false, error: null };
  const base = { health: async () => cold, voices: async () => [] };
  const main: Engine = {
    ...base, url: "http://main",
    synthesize: (_c, _o, signal) => (async function* (): AsyncGenerator<Pcm> {
      await new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
    })(),
  };
  const backup: Engine = {
    ...base, url: "http://127.0.0.1:6789",
    synthesize: () => (async function* (): AsyncGenerator<Pcm> {
      await new Promise((r) => setTimeout(r, FIRST_FRAME_MS - 100));
      yield new Uint8Array(400);
    })(),
  };
  // A stopped local server that answers just inside its start budget.
  let state = "standby";
  let demanded = false;
  const coldBackup = new ColdBackup({
    supervisor: () => ({
      status: () => ({ state }),
      demanded: () => demanded,
      demand: () => { demanded = true; },
      release: () => {},
      ready: () => new Promise<void>((r) => setTimeout(() => { state = "running"; r(); }, COLD_START_MS - 100)),
    }),
    mainHealth: async () => cold,
    mainBack: () => {},
  });
  const chain = new EngineChain({
    engines: () => ({ main, backup }),
    prepare: (slot, signal) => (slot === "backup" ? coldBackup.ensure(signal) : undefined),
  });
  chain.noteHealth("main", cold, main.url);
  const statuses: [number, EntryStatus, unknown][] = [];
  const hub = new PlayerHub({
    registry: new ClientRegistry(),
    routing: () => ({ playOn: "follow", pinnedDevice: null }),
    synthesize: (text, signal) => chain.synthesize(text, OPTS, signal),
    reportStatus: async (id, s, extra) => { statuses.push([id, s, extra]); },
  });
  try {
    const sock = new FakeSocket();
    hub.onMessage(sock, JSON.stringify({ type: "hello", clientId: "c", deviceName: "c", focusedAt: 1, audioUnlocked: true }));
    hub.speak(7, "Hi.", "t1", 1);
    for (let ms = 0; ms < BACKSTOP_MS && !sock.json.some((m) => m.type === "end"); ms += 100) {
      t.mock.timers.tick(100);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    }
    assert.ok(sock.json.some((m) => m.type === "end"), JSON.stringify(sock.json));
    assert.equal(sock.frames.length, 1);
    assert.equal(statuses.length, 0);
  } finally {
    hub.dispose();
  }
});
