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
  assert.equal(isLoopback("http://192.168.1.50:6789"), false);
  assert.equal(isLoopback("not a url"), false);
  assert.equal(portOf("http://127.0.0.1:6789"), 6789);
  assert.equal(portOf("https://tts.example"), 443);
});
