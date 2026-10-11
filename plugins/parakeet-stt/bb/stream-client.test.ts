import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamHandlers } from "./dictation.ts";
import { startBrowserStream, type StreamEnv } from "./stream-client.ts";
import { StreamServerError } from "./stream-protocol.ts";

type Fail = "AudioContext" | "addModule" | "createMediaStreamSource" | "AudioWorkletNode" | "WebSocket";

function build(fail?: Fail) {
  const rec = { revoked: [] as string[], contexts: [] as FakeContext[], sockets: [] as FakeSocket[], listeners: 0 };
  const tracks = [{ stops: 0, onended: null as (() => void) | null, stop() { this.stops++; } }, { stops: 0, onended: null as (() => void) | null, stop() { this.stops++; } }];

  class FakeContext {
    sampleRate = 16000;
    closed = 0;
    destination = {};
    audioWorklet = { addModule: async () => { if (fail === "addModule") throw new Error("addModule failed"); } };
    constructor() {
      if (fail === "AudioContext") throw new Error("AudioContext failed");
      rec.contexts.push(this);
    }
    createMediaStreamSource() {
      if (fail === "createMediaStreamSource") throw new Error("createMediaStreamSource failed");
      return { connect: (n: unknown) => n };
    }
    createGain() { return { gain: { value: 1 }, connect: (n: unknown) => n }; }
    async close() { this.closed++; }
  }
  class FakeNode {
    port = { onmessage: null as ((ev: { data: Float32Array }) => void) | null };
    constructor() { if (fail === "AudioWorkletNode") throw new Error("AudioWorkletNode failed"); }
    connect(n: unknown) { return n; }
  }
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    binaryType = "";
    closed = 0;
    sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      if (fail === "WebSocket") throw new Error("WebSocket failed");
      rec.sockets.push(this);
    }
    send(d: unknown) { this.sent.push(d); }
    close() { this.closed++; }
    emit(e: object) { this.onmessage!({ data: JSON.stringify(e) }); }
  }
  const doc = {
    visibilityState: "visible",
    addEventListener() { rec.listeners++; },
    removeEventListener() { rec.listeners--; },
  };
  const env = {
    getUserMedia: async () => ({ getTracks: () => tracks, getAudioTracks: () => tracks }),
    AudioContext: FakeContext,
    AudioWorkletNode: FakeNode,
    WebSocket: FakeSocket,
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: (u: string) => { rec.revoked.push(u); } },
    doc,
  } as unknown as StreamEnv;
  return { env, rec, tracks };
}

const handlers = (log: string[] = []): StreamHandlers => ({
  onPartial() {}, onFinal() {}, onCommand() {}, onState() {}, onHeard() {},
  onEnded: (r) => log.push(`ended:${r}`),
  onError: (m) => log.push(`error:${m}`),
});

const start = (env: StreamEnv, log: string[] = []) => startBrowserStream("ws://x/stream", handlers(log), () => {}, () => true, "dev", env);

for (const fail of ["AudioContext", "addModule", "createMediaStreamSource", "AudioWorkletNode", "WebSocket"] as const) {
  test(`${fail} throwing releases the mic, context, object URL and socket, then rethrows`, async () => {
    const { env, rec, tracks } = build(fail);
    await assert.rejects(start(env), new RegExp(`${fail} failed`));
    assert.deepEqual(tracks.map((t) => t.stops), [1, 1]);
    assert.deepEqual(rec.revoked, ["blob:fake"]);
    assert.equal(rec.listeners, 0);
    if (fail === "AudioContext") assert.equal(rec.contexts.length, 0);
    else assert.deepEqual(rec.contexts.map((c) => c.closed), [1]);
    assert.equal(rec.sockets.length, 0); // none of these gets as far as a socket
  });
}

test("a socket that errors before ready is closed and everything is released", async () => {
  const { env, rec, tracks } = build();
  const starting = start(env);
  await new Promise((r) => setTimeout(r, 0));
  rec.sockets[0].emit({ type: "error", message: "busy" });
  await assert.rejects(starting, /busy/);
  assert.equal(rec.sockets[0].closed >= 1, true);
  assert.deepEqual(tracks.map((t) => t.stops), [1, 1]);
  assert.deepEqual(rec.contexts.map((c) => c.closed), [1]);
  assert.deepEqual(rec.revoked, ["blob:fake"]);
});

test("a socket that closes before ready releases everything", async () => {
  const { env, rec, tracks } = build();
  const starting = start(env);
  await new Promise((r) => setTimeout(r, 0));
  rec.sockets[0].onclose!();
  await assert.rejects(starting, /stream connection failed/);
  assert.deepEqual(tracks.map((t) => t.stops), [1, 1]);
  assert.deepEqual(rec.contexts.map((c) => c.closed), [1]);
});

test("a normal stop clears the 30 s stop timer once the server ends the stream", async () => {
  const { env, rec } = build();
  const log: string[] = [];
  const starting = start(env, log);
  await new Promise((r) => setTimeout(r, 0));
  rec.sockets[0].emit({ type: "ready" });
  const handle = await starting;

  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const stopTimers: unknown[] = [];
  const cleared: unknown[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = realSet(fn, ms);
    if (ms === 30000) stopTimers.push(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => { cleared.push(id); realClear(id); }) as typeof clearTimeout;
  try {
    const stopping = handle.stop();
    assert.equal(stopTimers.length, 1);
    rec.sockets[0].emit({ type: "ended", reason: "stopped" });
    await stopping;
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  assert.ok(cleared.includes(stopTimers[0]), "stop timer was left pending");
  assert.deepEqual(log, ["ended:stopped"]);
});

test("server frames with Python-style spacing are handled like compact ones", async () => {
  const { env, rec } = build();
  const log: string[] = [];
  const h = { ...handlers(log), onFinal: (t: string, seq: number) => log.push(`final:${seq}:${t}`) };
  const starting = startBrowserStream("ws://x/stream", h, () => {}, () => true, "dev", env);
  await new Promise((r) => setTimeout(r, 0));
  const sock = rec.sockets[0];
  sock.onmessage!({ data: '{"type": "ready"}' });
  const handle = await starting;
  sock.onmessage!({ data: '{"type": "final", "seq": 3, "text": "hello world"}' });
  const stopping = handle.stop();
  sock.onmessage!({ data: '{"type": "ended", "reason": "stopped"}' });
  await stopping;
  assert.deepEqual(log, ["final:3:hello world", "ended:stopped"]);
});

test("cancel clears a pending stop timer", async () => {
  const { env, rec } = build();
  const starting = start(env);
  await new Promise((r) => setTimeout(r, 0));
  rec.sockets[0].emit({ type: "ready" });
  const handle = await starting;

  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const stopTimers: unknown[] = [];
  const cleared: unknown[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = realSet(fn, ms);
    if (ms === 30000) stopTimers.push(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => { cleared.push(id); realClear(id); }) as typeof clearTimeout;
  try {
    void handle.stop();
    handle.cancel();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  assert.ok(cleared.includes(stopTimers[0]), "stop timer was left pending");
});

test("a failure the server reported before ready is a StreamServerError; a browser-side one is not", async () => {
  const a = build();
  const reported = start(a.env);
  await new Promise((r) => setTimeout(r, 0));
  a.rec.sockets[0].emit({ type: "error", message: "Parakeet STT server URL is not set" });
  await assert.rejects(reported, (e: Error) => e instanceof StreamServerError && e.message === "Parakeet STT server URL is not set");

  const b = build();
  const closed = start(b.env);
  await new Promise((r) => setTimeout(r, 0));
  b.rec.sockets[0].onclose!();
  await assert.rejects(closed, (e: Error) => e instanceof StreamServerError);

  await assert.rejects(start(build("addModule").env), (e: Error) => !(e instanceof StreamServerError) && /addModule failed/.test(e.message));
});
