// Per-window player sockets: routes speech to chosen windows, streams PCM,
// waits for an ack once audio is sent, fails over once, and reports outcomes
// to the speech log. Plays one reply at a time, and when the window holding
// the output drops off (a phone losing signal or freezing), holds replies for
// it for a while instead of playing them on some other device.
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
  /** With `playback: "server"` no window holds the output. */
  routing: () => { playOn: PlayOn; pinnedDevice: string | null; playback?: "client" | "server" };
  synthesize: (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;
  reportStatus: (entryId: number, status: EntryStatus, extra?: { firstAudioMs?: number; error?: string }) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** How long a target has to ack playback, counted from the first audio frame it was sent. */
  ackTimeoutMs?: number;
  /** How long synthesis may take to produce the first audio frame, counted from speak(). */
  synthTimeoutMs?: number;
  sampleRate?: number;
  now?: () => number;
  /** How long replies wait for a holder that dropped off before normal routing resumes. */
  holdMs?: number;
  log?: (message: string) => void;
  /** Speech started or stopped playing in a window (the server lowers other audio if it is local). */
  speaking?: (e: { key: string; on: boolean; local?: boolean }) => void;
}

/** A holder window whose socket closed; replies wait for it until `until`. */
interface Away {
  deviceName: string;
  focusedAt: number;
  until: number;
  timer: unknown;
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
  /** A window reported it playing and speaking({on: true}) went out. */
  speaking: boolean;
  /** Finishes a playing reply whose "done" never arrives, so the queue can't stall. */
  doneTimer: unknown;
}

const HOLD_MS = 15 * 60_000;

export class PlayerHub {
  #deps: HubDeps;
  #setTimer: (fn: () => void, ms: number) => unknown;
  #clearTimer: (handle: unknown) => void;
  #sockets = new Map<string, SocketLike>();
  /** Latest hello info per socket (kept current by focus/unlocked), used to re-register a pruned client. */
  #socketInfo = new Map<SocketLike, PublicClientInfo>();
  /** Sockets from a window on this computer. */
  #localSockets = new WeakSet<SocketLike>();
  #jobs = new Map<number, Job>();
  #readyListeners = new Set<(ready: boolean) => void>();
  #lastReady = false;
  #now: () => number;
  /** Client ids holding the output: whose drop-off makes replies wait for them. */
  #holders = new Set<string>();
  #away: Away | null = null;
  /** Replies waiting their turn (another is playing, or the holder is away), oldest first. */
  #held: Job[] = [];
  /** The reply being delivered now; one at a time, so threads never talk over each other. */
  #current: Job | null = null;

  constructor(deps: HubDeps) {
    this.#deps = deps;
    this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#now = deps.now ?? Date.now;
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
        // A holder reconnecting (a phone whose signal blipped before the server saw
        // the close) gets its reply again from the start on the new socket below.
        const keep = this.#holders.has(msg.clientId) && this.#deps.routing().playOn !== "all";
        this.#dropTarget(msg.clientId, keep);
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
      this.#holders.delete(msg.clientId);
      this.#welcomeBack(info);
      this.#syncHolders();
      this.#releaseHeld();
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
      this.#welcomeBack(info);
      this.#syncHolders();
    }
    if (msg.type === "status") this.#onStatus(info.clientId, msg.entryId, msg.status, msg.firstAudioMs, msg.error);
    if (msg.type === "unlocked") this.#welcomeBack(info);
    if (msg.type === "focus" && this.#away && this.#follows() && info.deviceName !== this.#away.deviceName && info.focusedAt > this.#away.focusedAt) {
      // You picked up another device: the output follows you, held replies too.
      this.#endAway();
    }
    if (msg.type === "focus" || msg.type === "unlocked") this.#syncHolders();
    this.#checkReady();
  }

  onClose(socket: SocketLike): void {
    const info = this.#socketInfo.get(socket);
    if (!info) return;
    this.#socketInfo.delete(socket);
    const { clientId } = info;
    if (this.#sockets.get(clientId) !== socket) return;
    const wasHolder = this.#holders.delete(clientId);
    this.#sockets.delete(clientId);
    this.#deps.registry.remove(clientId);
    if (wasHolder && this.#deps.routing().playOn !== "all") this.#goAway(info);
    this.#dropTarget(clientId);
    this.#syncHolders();
    this.#checkReady();
  }

  /** The socket's window is on this computer (loopback); set when it opens. */
  markLocal(socket: SocketLike, local: boolean): void {
    if (local) this.#localSockets.add(socket);
    else this.#localSockets.delete(socket);
  }

  #isLocal(clientId: string): boolean {
    const socket = this.#sockets.get(clientId);
    return !!socket && this.#localSockets.has(socket);
  }

  /** Routing prefs changed: the holder may have moved. */
  routingChanged(): void {
    if (this.#away && !this.#awayActive()) this.#endAway();
    this.#syncHolders();
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
      report: Promise.resolve(), speaking: false, doneTimer: null,
    };
    this.#jobs.set(entryId, job);
    job.synthTimer = this.#setTimer(() => {
      if (!job.finished && job.frames.length === 0) {
        for (const id of job.targets) this.#send(id, { type: "stop", sessionId: job.sessionId });
        this.#finish(job, "error", "synthesis timeout");
      }
    }, this.#deps.synthTimeoutMs ?? 30_000);
    this.#noticeLostHolders();
    if (this.#awayActive() || this.#current) {
      // Wait for the holder to come back or for the reply playing now to end;
      // synthesize meanwhile so it starts right away.
      this.#held.push(job);
      void this.#pump(job);
      return;
    }
    this.#current = job;
    if (this.#target(job)) void this.#pump(job);
  }

  sound(sound: SoundName, volume: number, sessionId: string): void {
    this.#noticeLostHolders();
    if (this.#awayActive()) return;
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

  /** A window can play, or replies are being held for one that will be back. */
  /**
   * Keepalive from the server side. A hidden page's timers are throttled to about
   * once a minute, too slow to keep its socket from being closed as idle, but an
   * incoming message runs its handler right away and the answer keeps both
   * directions active.
   */
  pingAll(): void {
    for (const id of this.#sockets.keys()) this.#send(id, { type: "ping" });
  }

  /** Windows currently holding the output. */
  holderIds(): string[] {
    return [...this.#holders].sort();
  }

  hasReadyClient(): boolean {
    return this.#awayActive() || this.#deps.registry.select("all", null).length > 0;
  }

  clients(): PublicClientInfo[] {
    return this.#deps.registry.live().map(({ clientId, deviceName, focusedAt, audioUnlocked }) => ({
      clientId, deviceName, focusedAt, audioUnlocked, local: this.#isLocal(clientId),
    }));
  }

  dispose(): void {
    if (this.#away) this.#clearTimer(this.#away.timer);
    this.#away = null;
    this.stop(null);
    for (const socket of this.#sockets.values()) socket.close(1001, "plugin unloading");
    this.#sockets.clear();
    this.#socketInfo.clear();
    this.#readyListeners.clear();
  }

  /** Whether the output follows the last-used window (so using another device takes it). */
  #follows(): boolean {
    const { playOn, pinnedDevice } = this.#deps.routing();
    return playOn === "follow" || (playOn === "pinned" && !pinnedDevice);
  }

  /** Parks an undelivered or interrupted reply until the away holder is back. */
  #hold(job: Job): void {
    this.#stopSpeaking(job);
    this.#clearTimer(job.doneTimer);
    this.#clearTimer(job.timer);
    for (const id of job.targets) this.#send(id, { type: "stop", sessionId: job.sessionId });
    job.targets.clear();
    job.tried.clear();
    job.attempts = 0;
    job.acked = false;
    if (this.#current === job) this.#current = null;
    if (!this.#held.includes(job)) this.#held.unshift(job);
  }

  #awayActive(): boolean {
    const away = this.#away;
    if (!away || this.#now() >= away.until) return false;
    const { playOn, pinnedDevice, playback } = this.#deps.routing();
    if (playOn === "all" || playback === "server") return false;
    if (playOn === "pinned" && pinnedDevice && pinnedDevice !== away.deviceName) return false;
    return true;
  }

  #goAway(info: PublicClientInfo): void {
    if (this.#away) this.#clearTimer(this.#away.timer);
    const holdMs = this.#deps.holdMs ?? HOLD_MS;
    this.#deps.log?.(`holder ${info.deviceName} dropped off; holding replies for it`);
    this.#away = {
      deviceName: info.deviceName,
      focusedAt: info.focusedAt,
      until: this.#now() + holdMs,
      timer: this.#setTimer(() => {
        this.#endAway();
        this.#syncHolders();
        this.#checkReady();
      }, holdMs),
    };
  }

  /** Stops waiting for the away holder and delivers whatever was held to normal routing. */
  #endAway(): void {
    if (this.#away) {
      this.#clearTimer(this.#away.timer);
      this.#deps.log?.(`stopped holding for ${this.#away.deviceName}; releasing ${this.#held.length} held`);
    }
    this.#away = null;
    this.#releaseHeld();
  }

  /** A window of the away device is back and can play: it holds the output again. */
  #welcomeBack(info: PublicClientInfo): void {
    const away = this.#away;
    if (!away || info.deviceName !== away.deviceName || !info.audioUnlocked) return;
    if (info.focusedAt < away.focusedAt) {
      // A reloaded page has not been focused yet; keep its place as the last-used window.
      info.focusedAt = away.focusedAt;
      this.#deps.registry.update(info.clientId, { focusedAt: info.focusedAt });
    }
    this.#endAway();
  }

  #releaseHeld(): void {
    if (this.#awayActive()) return;
    while (!this.#current && this.#held.length > 0) {
      const job = this.#held.shift()!;
      if (job.finished) continue;
      this.#current = job;
      this.#target(job);
    }
  }

  /**
   * A holder whose page froze can keep its socket open while going silent, so the
   * registry prunes it without a close. Treat that like a close: hold for it.
   */
  #noticeLostHolders(): void {
    const { registry } = this.#deps;
    registry.live();
    for (const id of this.#holders) {
      if (registry.has(id)) continue;
      this.#holders.delete(id);
      const socket = this.#sockets.get(id);
      const info = socket ? this.#socketInfo.get(socket) : undefined;
      if (info && this.#deps.routing().playOn !== "all") this.#goAway(info);
    }
  }

  /** Recomputes which windows hold the output (would get the next reply). */
  #syncHolders(): void {
    this.#noticeLostHolders();
    const { playOn, pinnedDevice, playback } = this.#deps.routing();
    const idle = playback === "server" || this.#awayActive();
    const next = new Set(idle ? [] : this.#deps.registry.select(playOn, pinnedDevice));
    const names = (ids: Iterable<string>) => [...ids].map((id) => this.#infoOf(id)?.deviceName ?? id).sort().join(", ");
    if (names(next) !== names(this.#holders)) this.#deps.log?.(`output held by: ${names(next) || "nobody"}`);
    this.#holders = next;
  }

  /** The reply's full length plus slack; until synthesis completes, a generous minimum. */
  #armDoneWatch(job: Job): void {
    this.#clearTimer(job.doneTimer);
    const bytes = job.frames.reduce((n, f) => n + f.length, 0);
    const seconds = bytes / 4 / (this.#deps.sampleRate ?? 24_000);
    const ms = job.complete ? seconds * 1_000 + 30_000 : Math.max(120_000, seconds * 2_000);
    job.doneTimer = this.#setTimer(() => {
      if (job.finished) return;
      for (const id of job.targets) this.#send(id, { type: "stop", sessionId: job.sessionId });
      this.#finish(job, "error", "no end from window");
    }, ms);
  }

  #stopSpeaking(job: Job): void {
    if (!job.speaking) return;
    job.speaking = false;
    this.#deps.speaking?.({ key: String(job.entryId), on: false });
  }

  #infoOf(clientId: string): PublicClientInfo | undefined {
    const socket = this.#sockets.get(clientId);
    return socket ? this.#socketInfo.get(socket) : undefined;
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
  #dropTarget(clientId: string, keep = false): void {
    for (const job of [...this.#jobs.values()]) {
      if (!job.targets.delete(clientId)) continue;
      if (job.targets.size > 0) continue;
      // The holder dropped off (a phone losing signal): replay it from the start when it is back.
      if (keep || this.#awayActive()) this.#hold(job);
      else if (job.acked) this.#finish(job, "interrupted");
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
      if (job.acked) this.#armDoneWatch(job);
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
      if (!job.speaking) {
        job.speaking = true;
        this.#deps.speaking?.({ key: String(job.entryId), on: true, local: this.#isLocal(clientId) });
      }
      this.#armDoneWatch(job);
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
    this.#stopSpeaking(job);
    this.#clearTimer(job.doneTimer);
    this.#clearTimer(job.timer);
    this.#clearTimer(job.synthTimer);
    this.#jobs.delete(job.entryId);
    job.abort.abort();
    this.#report(job, status, error ? { error } : undefined);
    const held = this.#held.indexOf(job);
    if (held >= 0) this.#held.splice(held, 1);
    if (this.#current === job) {
      this.#current = null;
      this.#releaseHeld();
    }
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
