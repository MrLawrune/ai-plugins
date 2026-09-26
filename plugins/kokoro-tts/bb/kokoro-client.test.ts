import { test } from "node:test";
import assert from "node:assert/strict";
import { createKokoroClient, isLoopback, portOf, readFrames, ServerError } from "./kokoro-client.ts";

function frame(values: number[]): Uint8Array {
  const pcm = new Uint8Array(new Float32Array(values).buffer);
  const out = new Uint8Array(4 + pcm.length);
  new DataView(out.buffer).setUint32(0, pcm.length, true);
  out.set(pcm, 4);
  return out;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

test("readFrames splits length-prefixed frames across chunk boundaries", async () => {
  const all = new Uint8Array([...frame([0.5, -0.5]), ...frame([0.25])]);
  const chunks = [all.slice(0, 3), all.slice(3, 11), all.slice(11)];
  const got: number[][] = [];
  for await (const f of readFrames(streamOf(chunks))) got.push([...new Float32Array(f.slice().buffer)]);
  assert.deepEqual(got, [[0.5, -0.5], [0.25]]);
});

test("call maps a JSON error body with fields into ServerError", async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ error: "invalid config", fields: { speed: "too fast" } }), { status: 400 })) as typeof fetch;
  const client = createKokoroClient("http://127.0.0.1:6789/", fake);
  await assert.rejects(client.call("PATCH", "/config", { speed: 9 }), (e: unknown) => {
    assert.ok(e instanceof ServerError);
    assert.equal(e.message, "invalid config — speed: too fast");
    assert.deepEqual(e.fields, { speed: "too fast" });
    return true;
  });
});

test("call reports an unreachable server", async () => {
  const fake = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(createKokoroClient("http://127.0.0.1:1", fake).call("GET", "/health"), /unreachable/);
});

test("url helpers", () => {
  assert.equal(isLoopback("http://127.0.0.1:6789"), true);
  assert.equal(isLoopback("http://localhost:6789"), true);
  assert.equal(isLoopback("http://192.0.2.10:6789"), false);
  assert.equal(isLoopback("not a url"), false);
  assert.equal(portOf("http://127.0.0.1:6789"), 6789);
  assert.equal(portOf("https://tts.example"), 443);
});

const marker = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

// A real fetch errors the body when its signal aborts; the fake does the same.
test("call times out when the body stalls after the headers", { timeout: 2_000 }, async () => {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stalled = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
  const fake = (async (_url: string, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => ctrl.error(new Error("aborted")));
    return new Response(stalled, { status: 200 });
  }) as typeof fetch;
  const client = createKokoroClient("http://127.0.0.1:6789", fake, { default: 50, patch: 50 });
  await assert.rejects(client.call("GET", "/health"), ServerError);
});

test("readFrames with markers stops at the end marker", async () => {
  const got: number[] = [];
  for await (const f of readFrames(streamOf([frame([1]), marker(0), frame([9])]), { markers: true })) {
    got.push(new Float32Array(f.slice().buffer)[0]);
  }
  assert.deepEqual(got, [1]);
});

test("readFrames rejects an error marker", async () => {
  await assert.rejects(async () => {
    for await (const _ of readFrames(streamOf([frame([1]), marker(0xffffffff)]), { markers: true })) { /* drain */ }
  }, /failed mid-reply/);
});

test("readFrames rejects a truncated frame", async () => {
  const whole = frame([1, 2]);
  await assert.rejects(async () => {
    for await (const _ of readFrames(streamOf([whole.slice(0, 7)]))) { /* drain */ }
  }, /ended early/);
});

test("readFrames with markers rejects a stream that never ends", async () => {
  await assert.rejects(async () => {
    for await (const _ of readFrames(streamOf([frame([1])]), { markers: true })) { /* drain */ }
  }, /ended early/);
});

test("synthesize asks for terminated frames, forwards options, and rejects an empty reply", async () => {
  let sent: { headers?: HeadersInit; body?: BodyInit | null } = {};
  const fake = (async (_url: string, init?: RequestInit) => {
    sent = { headers: init?.headers, body: init?.body };
    return new Response(streamOf([marker(0)]), { status: 200, headers: { "X-Kokoro-Frames": "2" } });
  }) as typeof fetch;
  const client = createKokoroClient("http://127.0.0.1:6789", fake);
  await assert.rejects(async () => {
    for await (const _ of client.synthesize("Hi.", new AbortController().signal, { voice: "af_sky", speed: 1.2 })) { /* drain */ }
  }, /no audio/);
  assert.equal((sent.headers as Record<string, string>)["X-Kokoro-Frames"], "2");
  assert.deepEqual(JSON.parse(String(sent.body)), { text: "Hi.", voice: "af_sky", speed: 1.2 });
});
