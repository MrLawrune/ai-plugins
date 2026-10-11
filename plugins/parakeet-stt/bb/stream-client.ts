// Browser side of continuous dictation: mic → AudioWorklet → 16 kHz PCM16 frames → plugin relay socket.
import { guardCapture } from "./capture-guard.ts";
import type { Interruption, StreamHandle, StreamHandlers } from "./dictation.ts";
import { Resampler16k } from "./pcm.ts";
import { parseServerEvent } from "./stream-protocol.ts";
import { WORKLET_SOURCE } from "./worklet.ts";

const READY_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 30000;

/** Browser capabilities the stream needs; injectable so the failure paths run under node:test. */
export interface StreamEnv {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  AudioContext: typeof AudioContext;
  AudioWorkletNode: typeof AudioWorkletNode;
  WebSocket: typeof WebSocket;
  URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  doc: Document;
}

function browserStreamEnv(): StreamEnv {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") throw new Error("this browser cannot stream audio");
  return { getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c), AudioContext, AudioWorkletNode, WebSocket, URL, doc: document };
}

export async function startBrowserStream(url: string, h: StreamHandlers, onInterrupt: (why: Interruption) => void, keepListeningHidden: () => boolean = () => true, device?: string, env: StreamEnv = browserStreamEnv()): Promise<StreamHandle> {
  const media = await env.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let ctx: AudioContext | null = null;
  let moduleUrl: string | null = null;
  let ws: WebSocket | null = null;
  let unguard: (() => void) | null = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    media.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
    if (moduleUrl) env.URL.revokeObjectURL(moduleUrl);
    unguard?.();
  };
  let ready = false;
  let ended = false;
  let onEnd: (() => void) | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let tap: AudioWorkletNode;

  try {
    moduleUrl = env.URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try { ctx = new env.AudioContext({ sampleRate: 16000 }); } catch { ctx = new env.AudioContext(); }
    await ctx.audioWorklet.addModule(moduleUrl);
    const source = ctx.createMediaStreamSource(media);
    tap = new env.AudioWorkletNode(ctx, "pcm-tap");
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(tap).connect(sink).connect(ctx.destination);
    const resampler = new Resampler16k(ctx.sampleRate);

    const socket = new env.WebSocket(url);
    ws = socket;
    socket.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); release(); reject(new Error("stream did not become ready")); }, READY_TIMEOUT_MS);
      socket.onopen = () => socket.send(JSON.stringify({ type: "start", device }));
      socket.onmessage = (ev) => {
        const e = parseServerEvent(ev.data);
        if (!e) return;
        if (!ready) {
          if (e.type === "ready") { ready = true; clearTimeout(timer); resolve(); return; }
          if (e.type === "error") { clearTimeout(timer); socket.close(); release(); reject(new Error(e.message)); }
          return;
        }
        switch (e.type) {
          case "partial": h.onPartial(e.text, e.seq); break;
          case "final": h.onFinal(e.text, e.seq); break;
          case "command": h.onCommand(e.name); break;
          case "state": h.onState(e.waiting); break;
          case "heard": h.onHeard(e.text); break;
          case "error": h.onError(e.message); break;
          case "ended": ended = true; release(); h.onEnded(e.reason); onEnd?.(); socket.close(); break;
        }
      };
      socket.onclose = () => {
        if (!ready) { clearTimeout(timer); release(); reject(new Error("stream connection failed")); return; }
        if (!ended) { ended = true; release(); h.onError("Dictation stream closed unexpectedly"); h.onEnded("error"); onEnd?.(); }
      };
    });

    tap.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (socket.readyState !== env.WebSocket.OPEN) return;
      for (const frame of resampler.push(ev.data)) socket.send(frame.buffer);
    };
    unguard = guardCapture({ doc: env.doc, tracks: media.getAudioTracks(), keepListeningHidden, onInterrupt });
  } catch (e) {
    ended = true; // a socket that closes now belongs to a start that already failed
    ws?.close();
    release();
    throw e;
  }
  const socket = ws!;

  return {
    stop: () => new Promise<void>((resolve) => {
      if (ended) return resolve();
      onEnd = () => { clearTimeout(stopTimer); resolve(); };
      tap.port.onmessage = null;
      media.getTracks().forEach((t) => t.stop()); // stop the mic now; wait for the server's final phrase
      if (socket.readyState === env.WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
      stopTimer = setTimeout(() => { if (!ended) { ended = true; release(); socket.close(); h.onEnded("error"); resolve(); } }, STOP_TIMEOUT_MS);
    }),
    cancel: () => { ended = true; clearTimeout(stopTimer); tap.port.onmessage = null; release(); socket.close(); },
  };
}
