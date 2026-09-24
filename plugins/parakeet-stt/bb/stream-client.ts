// Browser side of continuous dictation: mic → AudioWorklet → 16 kHz PCM16 frames → plugin relay socket.
import { guardCapture } from "./capture-guard.ts";
import type { Interruption, StreamHandle, StreamHandlers } from "./dictation.ts";
import { Resampler16k } from "./pcm.ts";
import { parseServerEvent } from "./stream-protocol.ts";
import { WORKLET_SOURCE } from "./worklet.ts";

const READY_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 30000;

export async function startBrowserStream(url: string, h: StreamHandlers, onInterrupt: (why: Interruption) => void, keepListeningHidden: () => boolean = () => true): Promise<StreamHandle> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") throw new Error("this browser cannot stream audio");
  const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let ctx: AudioContext;
  try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); }
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    media.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => undefined);
    URL.revokeObjectURL(moduleUrl);
    unguard?.();
  };
  let unguard: (() => void) | null = null;

  try {
    await ctx.audioWorklet.addModule(moduleUrl);
  } catch (e) {
    release();
    throw e;
  }
  const source = ctx.createMediaStreamSource(media);
  const tap = new AudioWorkletNode(ctx, "pcm-tap");
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(tap).connect(sink).connect(ctx.destination);
  const resampler = new Resampler16k(ctx.sampleRate);

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let ready = false;
  let ended = false;
  let onEnd: (() => void) | null = null;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); release(); reject(new Error("stream did not become ready")); }, READY_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ type: "start" }));
    ws.onmessage = (ev) => {
      const e = parseServerEvent(ev.data);
      if (!e) return;
      if (!ready) {
        if (e.type === "ready") { ready = true; clearTimeout(timer); resolve(); return; }
        if (e.type === "error") { clearTimeout(timer); ws.close(); release(); reject(new Error(e.message)); }
        return;
      }
      switch (e.type) {
        case "partial": h.onPartial(e.text); break;
        case "final": h.onFinal(e.text); break;
        case "command": h.onCommand(e.name); break;
        case "error": h.onError(e.message); break;
        case "ended": ended = true; release(); h.onEnded(e.reason); onEnd?.(); ws.close(); break;
      }
    };
    ws.onclose = () => {
      if (!ready) { clearTimeout(timer); release(); reject(new Error("stream connection failed")); return; }
      if (!ended) { ended = true; release(); h.onError("Dictation stream closed unexpectedly"); h.onEnded("error"); onEnd?.(); }
    };
  });

  tap.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const frame of resampler.push(ev.data)) ws.send(frame.buffer);
  };
  unguard = guardCapture({ doc: document, tracks: media.getAudioTracks(), keepListeningHidden, onInterrupt });

  return {
    stop: () => new Promise<void>((resolve) => {
      if (ended) return resolve();
      onEnd = resolve;
      tap.port.onmessage = null;
      media.getTracks().forEach((t) => t.stop()); // stop the mic now; wait for the server's final phrase
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
      setTimeout(() => { if (!ended) { ended = true; release(); ws.close(); h.onEnded("error"); resolve(); } }, STOP_TIMEOUT_MS);
    }),
    cancel: () => { ended = true; tap.port.onmessage = null; release(); ws.close(); },
  };
}
