// AudioWorklet processor source, loaded from a Blob URL (no separate asset needed).
// Batches the 128-sample render quanta into 20 ms buffers at the context rate, so the main thread
// gets ~50 messages a second instead of ~375.
export const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * 0.02);
    this.buf = new Float32Array(this.size);
    this.fill = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(this.size - this.fill, ch.length - i);
      this.buf.set(ch.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === this.size) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;
