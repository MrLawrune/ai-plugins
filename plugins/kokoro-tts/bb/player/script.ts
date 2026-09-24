// Content script: one player socket per BB window. Reports focus and audio
// unlock, plays streamed speech gaplessly, plays sounds, acks each utterance.
import { decodeFrame, type ClientMsg, type ServerMsg, type SoundName } from "../protocol.ts";
import { DEVICE_NAME_EVENT, DEVICE_NAME_KEY, readClientId, readDeviceName, regenerateClientId } from "./device.ts";
import { PcmScheduler } from "./scheduler.ts";

interface Utterance {
  entryId: number;
  sessionId: string;
  sampleRate: number;
  gain: GainNode;
  sources: Set<AudioBufferSourceNode>;
  scheduler: PcmScheduler;
  startedAt: number;
  sentPlaying: boolean;
  ended: boolean;
}

export function mountPlayer({ pluginId, signal }: { pluginId: string; signal: AbortSignal }): () => void {
  let clientId = readClientId(sessionStorage);
  const base = `/api/v1/plugins/${encodeURIComponent(pluginId)}/http`;
  let ctx: AudioContext | null = null;
  let ws: WebSocket | null = null;
  let retryMs = 1_000;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let focusedAt = document.hasFocus() ? Date.now() : 0;
  let wasUnlocked = false;
  const utterances = new Map<number, Utterance>();
  const soundCache = new Map<SoundName, Promise<AudioBuffer>>();

  const audio = () => (ctx ??= new AudioContext());
  const unlocked = () => ctx?.state === "running";
  const send = (m: ClientMsg) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const hello = () =>
    send({ type: "hello", clientId, deviceName: readDeviceName(localStorage, navigator.userAgent), focusedAt, audioUnlocked: unlocked() });

  const unlock = () => {
    void audio().resume().then(() => {
      if (unlocked() && !wasUnlocked) {
        wasUnlocked = true;
        send({ type: "unlocked" });
      }
    });
  };
  const onFocus = () => {
    focusedAt = Date.now();
    send({ type: "focus", focusedAt });
  };
  const onVisible = () => {
    if (document.visibilityState === "visible" && document.hasFocus()) onFocus();
  };
  const onName = () => hello();
  const onStorage = (e: StorageEvent) => {
    if (e.key === DEVICE_NAME_KEY) hello();
  };

  function connect() {
    if (signal.aborted) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}${base}/player`);
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      retryMs = 1_000;
      hello();
      pingTimer = setInterval(() => send({ type: "ping" }), 15_000);
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") onServerMsg(JSON.parse(ev.data) as ServerMsg);
      else onFrame(new Uint8Array(ev.data as ArrayBuffer));
    };
    sock.onclose = (ev) => {
      clearInterval(pingTimer);
      stopAll(null);
      if (signal.aborted) return;
      if (ev.code === 4001) {
        // Another tab took over this clientId (duplicated sessionStorage, e.g. a
        // cloned tab): shed the shared id and reconnect as a fresh client right
        // away instead of backing off and fighting the other tab for it.
        clientId = regenerateClientId(sessionStorage);
        connect();
        return;
      }
      reconnectTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    };
  }

  function onServerMsg(m: ServerMsg) {
    switch (m.type) {
      case "speak": {
        stopAll(m.sessionId);
        if (!unlocked()) {
          send({ type: "status", entryId: m.entryId, status: "error", error: "audio locked" });
          return;
        }
        const c = audio();
        const gain = c.createGain();
        gain.gain.value = m.gain;
        gain.connect(c.destination);
        utterances.set(m.entryId, {
          entryId: m.entryId, sessionId: m.sessionId, sampleRate: m.sampleRate, gain,
          sources: new Set(), scheduler: new PcmScheduler(), startedAt: performance.now(),
          sentPlaying: false, ended: false,
        });
        return;
      }
      case "end": {
        const u = utterances.get(m.entryId);
        if (u) {
          u.ended = true;
          maybeDone(u);
        }
        return;
      }
      case "sound":
        void playSound(m.sound, m.volume);
        return;
      case "stop":
        stopAll(m.sessionId);
        return;
    }
  }

  function onFrame(buf: Uint8Array) {
    if (buf.length < 4) return;
    const { entryId, pcm } = decodeFrame(buf);
    const u = utterances.get(entryId);
    if (!u || !ctx || pcm.length === 0) return;
    const b = ctx.createBuffer(1, pcm.length, u.sampleRate);
    b.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(u.gain);
    src.onended = () => {
      u.sources.delete(src);
      maybeDone(u);
    };
    u.sources.add(src);
    src.start(u.scheduler.next(ctx.currentTime, b.duration));
    if (!u.sentPlaying) {
      u.sentPlaying = true;
      send({ type: "status", entryId, status: "playing", firstAudioMs: Math.round(performance.now() - u.startedAt) });
    }
  }

  function maybeDone(u: Utterance) {
    if (!u.ended || u.sources.size > 0 || !utterances.has(u.entryId)) return;
    utterances.delete(u.entryId);
    u.gain.disconnect();
    send({ type: "status", entryId: u.entryId, status: "done" });
  }

  function stopAll(sessionId: string | null) {
    for (const u of [...utterances.values()]) {
      if (sessionId !== null && u.sessionId !== sessionId) continue;
      utterances.delete(u.entryId);
      for (const s of u.sources) {
        s.onended = null;
        try {
          s.stop();
        } catch {
          // not started yet
        }
      }
      u.gain.disconnect();
      send({ type: "status", entryId: u.entryId, status: "interrupted" });
    }
  }

  async function playSound(name: SoundName, volume: number) {
    if (!unlocked()) return;
    const c = audio();
    let decoded = soundCache.get(name);
    if (!decoded) {
      decoded = fetch(`${base}/sound/${name}`).then((r) => r.arrayBuffer()).then((ab) => c.decodeAudioData(ab));
      soundCache.set(name, decoded);
      decoded.catch(() => soundCache.delete(name));
    }
    const buffer = await decoded;
    const g = c.createGain();
    g.gain.value = volume;
    g.connect(c.destination);
    const s = c.createBufferSource();
    s.buffer = buffer;
    s.connect(g);
    s.onended = () => g.disconnect();
    s.start();
  }

  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener(DEVICE_NAME_EVENT, onName);
  window.addEventListener("storage", onStorage);
  connect();

  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener(DEVICE_NAME_EVENT, onName);
    window.removeEventListener("storage", onStorage);
    clearInterval(pingTimer);
    clearTimeout(reconnectTimer);
    stopAll(null);
    ws?.close();
    void ctx?.close();
  };
}
