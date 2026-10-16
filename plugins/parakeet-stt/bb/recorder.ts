// Browser MediaRecorder wrapper. Picks a codec every major browser supports (iOS Safari only
// records audio/mp4) and stops on page hide (phone lock) or the 5-minute limit.
import { guardCapture } from "./capture-guard.ts";
import type { Interruption, RecordingHandle } from "./dictation.ts";

export const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"] as const;
export const MAX_RECORDING_MS = 300_000;

export function pickMimeType(isSupported: (t: string) => boolean): string | null {
  return MIME_PREFERENCE.find((t) => isSupported(t)) ?? null;
}

export function extensionFor(mime: string): string {
  if (mime.startsWith("audio/ogg")) return "ogg";
  if (mime.startsWith("audio/mp4")) return "m4a";
  return "webm";
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Browser capabilities the recorder needs; injectable so the failure paths run under node:test. */
export interface RecorderEnv {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  MediaRecorder: typeof MediaRecorder;
  doc: Document;
}

function browserRecorderEnv(): RecorderEnv {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("this browser cannot record audio");
  return { getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c), MediaRecorder, doc: document };
}

export async function startBrowserRecording(onInterrupt: (why: Interruption) => void, keepListeningHidden: () => boolean = () => true, env: RecorderEnv = browserRecorderEnv()): Promise<RecordingHandle & { mimeType: string }> {
  const stream = await env.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let limit: ReturnType<typeof setTimeout> | undefined;
  let unguard: (() => void) | null = null;
  const release = () => {
    stream.getTracks().forEach((t) => t.stop());
    unguard?.();
    unguard = null;
    clearTimeout(limit);
  };
  const chunks: Blob[] = [];
  let recorder: MediaRecorder;
  let mimeType: string;
  try {
    mimeType = pickMimeType((t) => env.MediaRecorder.isTypeSupported(t)) ?? "";
    recorder = mimeType ? new env.MediaRecorder(stream, { mimeType }) : new env.MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    limit = setTimeout(() => onInterrupt("limit"), MAX_RECORDING_MS);
    unguard = guardCapture({ doc: env.doc, tracks: stream.getAudioTracks(), keepListeningHidden, onInterrupt });
    recorder.start(1000); // timeslice: keeps captured audio if the page is suspended
  } catch (e) {
    release();
    throw e;
  }
  const type = recorder.mimeType || mimeType || "audio/webm";
  return {
    mimeType: type,
    stop: () => new Promise<Blob>((resolve) => {
      const finish = () => { release(); resolve(new Blob(chunks, { type })); };
      if (recorder.state === "inactive") finish();
      else { recorder.onstop = finish; recorder.stop(); }
    }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}
