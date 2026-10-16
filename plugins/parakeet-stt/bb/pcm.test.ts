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

/** The pre-ring implementation, kept verbatim as the golden reference. */
class ReferenceResampler {
  #ratio: number;
  #pos = 0;
  #carry: Float32Array = new Float32Array(0);
  #out: number[] = [];

  constructor(inputRate: number) {
    this.#ratio = inputRate / 16000;
  }

  push(input: Float32Array): Int16Array[] {
    const buf = new Float32Array(this.#carry.length + input.length);
    buf.set(this.#carry);
    buf.set(input, this.#carry.length);
    const step = this.#ratio;
    let pos = this.#pos;
    while (pos + (step > 1 ? step : 1) <= buf.length) {
      let v: number;
      if (step > 1) {
        const a = Math.floor(pos);
        const b = Math.min(buf.length, Math.floor(pos + step));
        let sum = 0;
        for (let i = a; i < b; i++) sum += buf[i];
        v = sum / Math.max(1, b - a);
      } else {
        const i = Math.floor(pos);
        const frac = pos - i;
        v = i + 1 < buf.length ? buf[i] * (1 - frac) + buf[i + 1] * frac : buf[i];
      }
      this.#out.push(Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
      pos += step;
    }
    const consumed = Math.floor(pos);
    this.#carry = buf.slice(consumed);
    this.#pos = pos - consumed;
    const frames: Int16Array[] = [];
    while (this.#out.length >= FRAME_SAMPLES) frames.push(Int16Array.from(this.#out.splice(0, FRAME_SAMPLES)));
    return frames;
  }
}

function signal(rate: number): Float32Array {
  // 1 s of a 440 Hz sine plus a deterministic ripple, so the filter sees more than one tone
  const x = new Float32Array(rate);
  for (let i = 0; i < rate; i++) x[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / rate) + 0.3 * Math.sin((2 * Math.PI * 3100 * i) / rate);
  return x;
}

for (const rate of [48000, 44100, 22050, 16000, 8000]) {
  for (const chunk of [128, 960, 1]) {
    test(`ring resampler matches the reference at ${rate} Hz in ${chunk}-sample chunks`, () => {
      const x = rate === 8000 || chunk === 1 ? signal(rate).subarray(0, 4000) : signal(rate);
      const ref = new ReferenceResampler(rate);
      const next = new Resampler16k(rate);
      const want: Int16Array[] = [];
      const got: Int16Array[] = [];
      for (let i = 0; i < x.length; i += chunk) {
        const part = x.subarray(i, Math.min(x.length, i + chunk));
        want.push(...ref.push(part));
        got.push(...next.push(part));
      }
      assert.ok(want.length > 0);
      assert.equal(got.length, want.length);
      for (let i = 0; i < want.length; i++) assert.deepEqual(got[i], want[i], `frame ${i}`);
    });
  }
}

test("frames are independent buffers (reusing the fill frame must not alias emitted ones)", () => {
  const r = new Resampler16k(16000);
  const frames = r.push(new Float32Array(640).fill(0.25));
  assert.equal(frames.length, 2);
  assert.notEqual(frames[0].buffer, frames[1].buffer);
  const first = Array.from(frames[0]);
  r.push(new Float32Array(640).fill(-0.5));
  assert.deepEqual(Array.from(frames[0]), first);
});
