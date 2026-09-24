// Float32 audio at the AudioContext rate → Int16 at 16 kHz in 20 ms frames, state carried across calls.
export const FRAME_SAMPLES = 320;

export class Resampler16k {
  #ratio: number;
  #pos = 0; // fractional read position into #carry + next input
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
        // box filter over the input window this output sample covers
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
