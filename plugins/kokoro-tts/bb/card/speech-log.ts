// One speech-log poll per thread, shared by every card of that thread on the
// page; it fetches only that thread's entries and runs only while a card waits.
import { useEffect, useMemo, useReducer } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract.ts";
import type { SpeechLogEntry } from "../schemas.ts";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const POLL_MS = 2_500;
const RETRY_MS = 8_000;
/** A card mounting within this long of the last good fetch reuses it instead of refetching. */
const FRESH_MS = 2_000;

class ThreadLog {
  readonly listeners = new Set<() => void>();
  /** Cards that are queued or playing; the poll stops when this is empty. */
  readonly waiting = new Set<symbol>();
  entries: SpeechLogEntry[] | null = null;
  rpc: Rpc | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  inflight = false;
  /** A refresh came in while a fetch was in flight: fetch again once it settles. */
  dirty = false;
  /** Bumped by refresh(): a response to an older request is dropped. */
  gen = 0;
  failed = false;
  /** When the last fetch succeeded; 0 before the first. */
  fetchedAt = 0;

  constructor(readonly threadId: string) {}

  schedule(): void {
    if (this.timer || this.inflight || this.waiting.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Cards re-render (and may settle) after a fetch, so check again when the timer fires.
      if (this.waiting.size > 0) void this.fetch();
    }, this.failed ? RETRY_MS : POLL_MS);
  }

  async fetch(): Promise<void> {
    this.timer = null;
    if (!this.rpc) return;
    if (this.inflight) {
      this.dirty = true;
      return;
    }
    this.inflight = true;
    this.dirty = false;
    const gen = generation;
    const mine = this.gen;
    try {
      const r = await this.rpc.call("speechLog", { threadId: this.threadId });
      if (gen !== generation) return;
      if (mine === this.gen) {
        this.entries = r.entries;
        this.failed = false;
        this.fetchedAt = Date.now();
      }
    } catch {
      if (gen !== generation) return;
      if (mine === this.gen) this.failed = true; // keep the last entries; cards keep their last state
    }
    this.inflight = false;
    // Asked again while this one ran (the history was cleared, say): its answer may predate that.
    if (this.dirty) {
      void this.fetch();
      return;
    }
    for (const notify of this.listeners) notify();
    this.schedule();
  }

  /** Fetches now; an answer still in flight is dropped and a new fetch follows it. */
  refresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.gen++;
    void this.fetch();
  }

  /** The history was cleared: show no entries now, then refetch. */
  cleared(): void {
    this.entries = [];
    this.fetchedAt = 0;
    for (const notify of this.listeners) notify();
    this.refresh();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

const logs = new Map<string, ThreadLog>();
/** Cards mounted on the page, across threads. */
let mounted = 0;
/** Bumped by resetSpeechLogForTests so an in-flight fetch from a previous mount is ignored. */
let generation = 0;

function logFor(threadId: string): ThreadLog {
  let log = logs.get(threadId);
  if (!log) logs.set(threadId, (log = new ThreadLog(threadId)));
  return log;
}

export function refreshSpeechLog(threadId: string): void {
  logs.get(threadId)?.refresh();
}

/** Refetch every thread's log that still has a card mounted. */
export function refreshAllSpeechLogs(): void {
  for (const log of logs.values()) if (log.listeners.size > 0) log.refresh();
}

/** The history was cleared: every mounted card's log empties now and is refetched. */
export function clearAllSpeechLogs(): void {
  for (const log of logs.values()) if (log.listeners.size > 0) log.cleared();
}

const onVisible = () => {
  if (document.visibilityState === "visible") refreshAllSpeechLogs();
};

export function useSpeechLog(threadId: string, pending: boolean): SpeechLogEntry[] | null {
  const rpc = useRpc<typeof rpcContract>();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const token = useMemo(() => Symbol("kokoro-card"), []);
  // A thread's log lives while one of its cards is mounted, so effects look it
  // up rather than holding the one this render saw.
  useEffect(() => {
    const log = logFor(threadId);
    log.rpc = rpc;
    if (mounted++ === 0) document.addEventListener("visibilitychange", onVisible);
    log.listeners.add(rerender);
    if (!log.inflight && Date.now() - log.fetchedAt >= FRESH_MS) log.refresh();
    return () => {
      log.listeners.delete(rerender);
      log.waiting.delete(token);
      if (log.listeners.size === 0) {
        log.stop();
        if (logs.get(threadId) === log) logs.delete(threadId);
      }
      if (--mounted === 0) document.removeEventListener("visibilitychange", onVisible);
    };
  }, [rpc, token, threadId]);
  useEffect(() => {
    const log = logFor(threadId);
    if (pending) {
      log.waiting.add(token);
      log.schedule();
    } else {
      log.waiting.delete(token);
    }
  }, [pending, token, threadId, rpc]);
  return logs.get(threadId)?.entries ?? null;
}

/** Tests only: forget the shared polls between renders. */
export function resetSpeechLogForTests(): void {
  generation++;
  for (const log of logs.values()) log.stop();
  logs.clear();
  mounted = 0;
  document.removeEventListener("visibilitychange", onVisible);
}
