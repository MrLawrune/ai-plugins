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

export async function startBrowserRecording(onInterrupt: (why: Interruption) => void, keepListeningHidden: () => boolean = () => true): Promise<RecordingHandle & { mimeType: string }> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("this browser cannot record audio");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const limit = setTimeout(() => onInterrupt("limit"), MAX_RECORDING_MS);
  const release = () => {
    stream.getTracks().forEach((t) => t.stop());
    unguard();
    clearTimeout(limit);
  };
  const unguard = guardCapture({ doc: document, tracks: stream.getAudioTracks(), keepListeningHidden, onInterrupt });
  recorder.start(1000); // timeslice: keeps captured audio if the page is suspended
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
