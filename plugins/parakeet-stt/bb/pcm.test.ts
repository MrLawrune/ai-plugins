import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_SAMPLES, Resampler16k } from "./pcm.ts";

test("16 kHz input passes through in 20 ms frames", () => {
  const r = new Resampler16k(16000);
  const frames = r.push(new Float32Array(700).fill(0.5));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, FRAME_SAMPLES);
  assert.ok(Math.abs(frames[0][0] - 16384) <= 1);
  assert.equal(r.push(new Float32Array(0)).length, 0);
  assert.equal(r.push(new Float32Array(260)).length, 1); // 60 carried + 260
});

test("48 kHz downsamples 3:1 across calls without drift", () => {
  const r = new Resampler16k(48000);
  let out = 0;
  for (let i = 0; i < 300; i++) out += r.push(new Float32Array(128)).reduce((n, f) => n + f.length, 0);
  // 38400 input samples -> 12800 output samples; frames only emit when full
  assert.ok(12800 - out < FRAME_SAMPLES && out % FRAME_SAMPLES === 0);
});

test("clips out-of-range samples", () => {
  const f = new Resampler16k(16000).push(new Float32Array(320).fill(2))[0];
  assert.equal(f[0], 32767);
});
