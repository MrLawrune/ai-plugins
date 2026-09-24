// AudioWorklet processor source, loaded from a Blob URL (no separate asset needed).
export const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;
