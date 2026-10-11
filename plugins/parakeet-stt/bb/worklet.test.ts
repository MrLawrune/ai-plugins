import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKLET_SOURCE } from "./worklet.ts";

/** Evaluates the worklet source against a fake AudioWorkletGlobalScope at `sampleRate`. */
function load(sampleRate: number) {
  const posted: Array<{ data: Float32Array; transfer: unknown[] }> = [];
  class FakeProcessor {
    port = { postMessage: (data: Float32Array, transfer: unknown[]) => { posted.push({ data, transfer }); } };
  }
  let Processor: (new () => { process(inputs: Float32Array[][]): boolean }) | null = null;
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", WORKLET_SOURCE)(
    FakeProcessor,
    (_name: string, ctor: typeof Processor) => { Processor = ctor; },
    sampleRate,
  );
  return { node: new Processor!(), posted };
}

const block = (n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => from + i);

test("posts one 20 ms buffer per full buffer, not one message per 128-sample block", () => {
  for (const [rate, size] of [[48000, 960], [44100, 882], [16000, 320]] as const) {
    const { node, posted } = load(rate);
    let fed = 0;
    while (posted.length < 2) { node.process([[block(128, fed)]]); fed += 128; }
    assert.equal(posted[0].data.length, size, `${rate} Hz`);
    assert.equal(posted[1].data.length, size);
    assert.equal(posted[0].data[0], 0);
    assert.equal(posted[0].data[size - 1], size - 1); // samples keep their order across blocks
    assert.equal(posted[1].data[0], size);
    assert.deepEqual(posted[0].transfer, [posted[0].data.buffer]);
    assert.equal(posted[0].data.buffer.byteLength, size * 4);
  }
});

test("a block that straddles the buffer boundary is split without losing samples", () => {
  const { node, posted } = load(16000); // 320-sample buffers
  node.process([[block(300)]]);
  assert.equal(posted.length, 0);
  node.process([[block(128, 300)]]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].data[319], 319);
  node.process([[block(512, 428)]]);
  assert.equal(posted.length, 2);
  assert.equal(posted[1].data[0], 320);
});

test("keeps the processor alive on empty or missing input", () => {
  const { node, posted } = load(48000);
  assert.equal(node.process([]), true);
  assert.equal(node.process([[]]), true);
  assert.equal(node.process([[new Float32Array(0)]]), true);
  assert.equal(posted.length, 0);
});
