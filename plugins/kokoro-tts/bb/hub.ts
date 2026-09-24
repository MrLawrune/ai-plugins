// Per-window player sockets: routes speech to chosen windows, streams PCM,
// waits for an ack once audio is sent, fails over once, and reports outcomes
// to the speech log.
import type { ClientRegistry } from "./clients.ts";
import { encodeFrame, parseClientMsg, type ServerMsg, type SoundName } from "./protocol.ts";
import type { PlayOn, PublicClientInfo } from "./schemas.ts";

export interface SocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type EntryStatus = "playing" | "done" | "interrupted" | "error";

export interface HubDeps {
  registry: ClientRegistry;
  routing: () => { playOn: PlayOn; pinnedDevice: string | null };
  synthesize: (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;
  reportStatus: (entryId: number, status: EntryStatus, extra?: { firstAudioMs?: number; error?: string }) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** How long a target has to ack playback, counted from the first audio frame it was sent. */
  ackTimeoutMs?: number;
  /** How long synthesis may take to produce the first audio frame, counted from speak(). */
  synthTimeoutMs?: number;
  sampleRate?: number;
}

interface Job {
  entryId: number;
  text: string;
  sessionId: string;
  gain: number;
  frames: Uint8Array[];
  complete: boolean;
  targets: Set<string>;
  tried: Set<string>;
  attempts: number;
  acked: boolean;
  finished: boolean;
  abort: AbortController;
  /** Ack deadline; armed only once the current targets have been sent audio. */
  timer: unknown;
  /** First-frame deadline; cleared when synthesis produces its first frame. */
  synthTimer: unknown;
  /** Chain that serializes reportStatus calls for this entry so "done" can never be sent before "playing" resolves. */
  report: Promise<void>;
}

export class PlayerHub {
  #deps: HubDeps;
  #setTimer: (fn: () => void, ms: number) => unknown;
  #clearTimer: (handle: unknown) => void;
  #sockets = new Map<string, SocketLike>();
  /** Latest hello info per socket (kept current by focus/unlocked), used to re-register a pruned client. */
  #socketInfo = new Map<SocketLike, PublicClientInfo>();
  #jobs = new Map<number, Job>();
  #readyListeners = new Set<(ready: boolean) => void>();
  #lastReady = false;

  constructor(deps: HubDeps) {
    this.#deps = deps;
    this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  onMessage(socket: SocketLike, raw: string | Uint8Array): void {
    if (typeof raw !== "string") return;
    const msg = parseClientMsg(raw);
    if (!msg) return;
    const { registry } = this.#deps;
    if (msg.type === "hello") {
      const previous = this.#sockets.get(msg.clientId);
      if (previous && previous !== socket) {
        this.#socketInfo.delete(previous);
        // Reconnect under the same clientId: the old socket's close (if it ever
        // arrives) must not re-run job cleanup for a client that already moved on.
        this.#dropTarget(msg.clientId);
        // Tell the superseded tab why, so it can shed the duplicated sessionStorage
        // id and reconnect as a fresh client instead of endlessly fighting this one.
        try {
          previous.close(4001, "superseded");
        } catch {
          // already closing
        }
      }
      const info = { clientId: msg.clientId, deviceName: msg.deviceName, focusedAt: msg.focusedAt, audioUnlocked: msg.audioUnlocked };
      this.#sockets.set(msg.clientId, socket);
      this.#socketInfo.set(socket, info);
      registry.upsert({ ...info });
      this.#checkReady();
      return;
    }
    const info = this.#socketInfo.get(socket);
    if (!info) return;
    if (msg.type === "focus") info.focusedAt = msg.focusedAt;
    if (msg.type === "unlocked") info.audioUnlocked = true;
    // Any message proves the window is alive. A throttled background tab can go
    // quiet past the registry TTL and get pruned while its socket stays open;
    // re-register it from the stored hello info rather than losing it for good.
    if (registry.has(info.clientId)) {
      registry.update(info.clientId, { focusedAt: info.focusedAt, audioUnlocked: info.audioUnlocked });
    } else {
      registry.upsert({ ...info });
    }
    if (msg.type === "status") this.#onStatus(info.clientId, msg.entryId, msg.status, msg.firstAudioMs, msg.error);
    this.#checkReady();
  }

  onClose(socket: SocketLike): void {
    const info = this.#socketInfo.get(socket);
    if (!info) return;
    this.#socketInfo.delete(socket);
    const { clientId } = info;
    if (this.#sockets.get(clientId) !== socket) return;
    this.#sockets.delete(clientId);
    this.#deps.registry.remove(clientId);
    this.#dropTarget(clientId);
    this.#checkReady();
  }

  /** Subscribes to changes of hasReadyClient() caused by window messages or closes. */
  onReadyChange(listener: (ready: boolean) => void): () => void {
    this.#readyListeners.add(listener);
    return () => { this.#readyListeners.delete(listener); };
  }

  speak(entryId: number, text: string, sessionId: string, gain: number): void {
    this.stop(sessionId);
    const job: Job = {
      entryId, text, sessionId, gain, frames: [], complete: false, targets: new Set(), tried: new Set(),
      attempts: 0, acked: false, finished: false, abort: new AbortController(), timer: null, synthTimer: null,
      report: Promise.resolve(),
    };
    this.#jobs.set(entryId, job);
    job.synthTimer = this.#setTimer(() => {
      if (!job.finished && job.frames.length === 0) {
        for (const id of job.targets) this.#send(id, { type: "stop", sessionId: job.sessionId });
        this.#finish(job, "error", "synthesis timeout");
      }
    }, this.#deps.synthTimeoutMs ?? 30_000);
    if (this.#target(job)) void this.#pump(job);
  }

  sound(sound: SoundName, volume: number, sessionId: string): void {
    const { playOn, pinnedDevice } = this.#deps.routing();
    for (const id of this.#deps.registry.select(playOn, pinnedDevice)) {
      this.#send(id, { type: "sound", sound, volume, sessionId });
    }
  }

  stop(sessionId: string | null): void {
    for (const job of [...this.#jobs.values()]) {
      if (sessionId !== null && job.sessionId !== sessionId) continue;
      for (const id of job.targets) this.#send(id, { type: "stop", sessionId: job.sessionId });
      this.#finish(job, "interrupted");
    }
  }

  hasReadyClient(): boolean {
    return this.#deps.registry.select("all", null).length > 0;
  }

  clients(): PublicClientInfo[] {
    return this.#deps.registry.live().map(({ clientId, deviceName, focusedAt, audioUnlocked }) => ({
      clientId, deviceName, focusedAt, audioUnlocked,
    }));
  }

  dispose(): void {
    this.stop(null);
    for (const socket of this.#sockets.values()) socket.close(1001, "plugin unloading");
    this.#sockets.clear();
    this.#socketInfo.clear();
    this.#readyListeners.clear();
  }

  #checkReady(): void {
    const ready = this.hasReadyClient();
    if (ready === this.#lastReady) return;
    this.#lastReady = ready;
    for (const listener of this.#readyListeners) {
      try {
        listener(ready);
      } catch {
        // a listener's failure must not break socket handling
      }
    }
  }

  /**
   * Removes a client from every job that currently targets it (socket closed, or
   * a reconnect under the same clientId superseded it). Only acts once the client's
   * removal leaves the job with zero remaining targets -- other live targets (e.g.
   * under the "all" rule) must keep playing undisturbed.
   */
  #dropTarget(clientId: string): void {
    for (const job of [...this.#jobs.values()]) {
      if (!job.targets.delete(clientId)) continue;
      if (job.targets.size > 0) continue;
      if (job.acked) this.#finish(job, "interrupted");
      else this.#failover(job);
    }
  }

  #target(job: Job): boolean {
    job.attempts += 1;
    const { playOn, pinnedDevice } = this.#deps.routing();
    const ids = this.#deps.registry.select(playOn, pinnedDevice, job.tried);
    if (ids.length === 0) {
      this.#finish(job, "error", "no client");
      return false;
    }
    const speak: ServerMsg = {
      type: "speak", entryId: job.entryId, sessionId: job.sessionId,
      sampleRate: this.#deps.sampleRate ?? 24_000, gain: job.gain,
    };
    for (const id of ids) {
      job.tried.add(id);
      job.targets.add(id);
      this.#send(id, speak);
      for (const pcm of job.frames) this.#sendFrame(id, job.entryId, pcm);
      if (job.complete) this.#send(id, { type: "end", entryId: job.entryId });
    }
    // With no audio buffered yet, #pump arms the ack deadline on the first frame:
    // a target can't ack before it has something to play.
    if (job.frames.length > 0) this.#armAck(job);
    return true;
  }

  /** Starts the ack deadline for the current targets, which have just been sent audio. */
  #armAck(job: Job): void {
    this.#clearTimer(job.timer);
    job.timer = this.#setTimer(() => {
      if (!job.acked && !job.finished) this.#failover(job);
    }, this.#deps.ackTimeoutMs ?? 3_000);
  }

  #failover(job: Job): void {
    this.#clearTimer(job.timer);
    for (const id of job.targets) this.#send(id, { type: "stop", sessionId: job.sessionId });
    job.targets.clear();
    if (job.attempts >= 2) {
      this.#finish(job, "error", "no client");
      return;
    }
    this.#target(job);
  }

  async #pump(job: Job): Promise<void> {
    try {
      for await (const pcm of this.#deps.synthesize(job.text, job.abort.signal)) {
        if (job.finished) return;
        job.frames.push(pcm);
        for (const id of job.targets) this.#sendFrame(id, job.entryId, pcm);
        if (job.frames.length === 1) {
          this.#clearTimer(job.synthTimer);
          if (!job.acked && job.targets.size > 0) this.#armAck(job);
        }
      }
      if (job.finished) return;
      job.complete = true;
      for (const id of job.targets) this.#send(id, { type: "end", entryId: job.entryId });
    } catch (cause) {
      if (!job.finished) {
        for (const id of job.targets) this.#send(id, { type: "stop", sessionId: job.sessionId });
        this.#finish(job, "error", String(cause).slice(0, 200));
      }
    }
  }

  #onStatus(clientId: string, entryId: number, status: EntryStatus, firstAudioMs?: number, error?: string): void {
    const job = this.#jobs.get(entryId);
    if (!job || !job.targets.has(clientId)) return;
    if (status === "playing") {
      if (job.acked) return;
      job.acked = true;
      this.#clearTimer(job.timer);
      this.#report(job, "playing", { firstAudioMs });
      return;
    }
    job.targets.delete(clientId);
    if (job.targets.size > 0) return;
    // "done" from a window that never reported "playing" means it played nothing
    // (no audio reached it); never log that as a successful utterance.
    if (status === "done" && !job.acked) {
      this.#finish(job, "error", "no audio");
      return;
    }
    // Pre-ack error/interrupted means the window closed or autoplay was blocked
    // before it ever confirmed playback -- retarget once rather than finalizing.
    if (!job.acked && (status === "error" || status === "interrupted")) {
      this.#failover(job);
      return;
    }
    if (status === "done") this.#finish(job, "done");
    else this.#finish(job, status, error);
  }

  #finish(job: Job, status: EntryStatus, error?: string): void {
    if (job.finished) return;
    job.finished = true;
    this.#clearTimer(job.timer);
    this.#clearTimer(job.synthTimer);
    this.#jobs.delete(job.entryId);
    job.abort.abort();
    this.#report(job, status, error ? { error } : undefined);
  }

  /** Chains a reportStatus call after the job's previous one so entries land in order. */
  #report(job: Job, status: EntryStatus, extra?: { firstAudioMs?: number; error?: string }): void {
    job.report = job.report.then(() => this.#deps.reportStatus(job.entryId, status, extra)).catch(() => undefined);
  }

  #send(clientId: string, msg: ServerMsg): void {
    try {
      this.#sockets.get(clientId)?.send(JSON.stringify(msg));
    } catch {
      // socket already closing; onClose handles cleanup
    }
  }

  #sendFrame(clientId: string, entryId: number, pcm: Uint8Array): void {
    try {
      this.#sockets.get(clientId)?.send(encodeFrame(entryId, pcm));
    } catch {
      // see #send
    }
  }
}
