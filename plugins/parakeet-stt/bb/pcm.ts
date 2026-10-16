// Float32 audio at the AudioContext rate → Int16 at 16 kHz in 20 ms frames, state carried across calls.
export const FRAME_SAMPLES = 320;

export class Resampler16k {
  #ratio: number;
  #pos = 0; // fractional read position into the carried samples + next input
  #buf = new Float32Array(0); // [carried samples | input of the current push]
  #carryLen = 0; // at most ceil(ratio) + 1 samples survive between pushes
  #frame = new Int16Array(FRAME_SAMPLES);
  #fill = 0;

  constructor(inputRate: number) {
    this.#ratio = inputRate / 16000;
  }

  push(input: Float32Array): Int16Array[] {
    const len = this.#carryLen + input.length;
    if (this.#buf.length < len) {
      const grown = new Float32Array(len);
      grown.set(this.#buf.subarray(0, this.#carryLen));
      this.#buf = grown;
    }
    const buf = this.#buf;
    buf.set(input, this.#carryLen);
    const step = this.#ratio;
    const frames: Int16Array[] = [];
    let pos = this.#pos;
    while (pos + (step > 1 ? step : 1) <= len) {
      let v: number;
      if (step > 1) {
        // box filter over the input window this output sample covers
        const a = Math.floor(pos);
        const b = Math.min(len, Math.floor(pos + step));
        let sum = 0;
        for (let i = a; i < b; i++) sum += buf[i];
        v = sum / Math.max(1, b - a);
      } else {
        const i = Math.floor(pos);
        const frac = pos - i;
        v = i + 1 < len ? buf[i] * (1 - frac) + buf[i + 1] * frac : buf[i];
      }
      this.#frame[this.#fill++] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
      if (this.#fill === FRAME_SAMPLES) {
        frames.push(this.#frame.slice());
        this.#fill = 0;
      }
      pos += step;
    }
    const consumed = Math.floor(pos);
    buf.copyWithin(0, consumed, len);
    this.#carryLen = len - consumed;
    this.#pos = pos - consumed;
    return frames;
  }
}
