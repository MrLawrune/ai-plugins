// One speech-log poll shared by every card on the page; it runs only while some card is waiting.
import { useEffect, useMemo, useReducer } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, SpeechLogEntry } from "../schemas.ts";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const POLL_MS = 2_500;
const RETRY_MS = 8_000;

const listeners = new Set<() => void>();
/** Cards that are queued or playing; the poll stops when this is empty. */
const waiting = new Set<symbol>();
let entries: SpeechLogEntry[] | null = null;
let activeRpc: Rpc | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = false;
let failed = false;
/** Bumped by resetSpeechLogForTests so an in-flight fetch from a previous mount is ignored. */
let generation = 0;

function schedule(): void {
  if (timer || inflight || waiting.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    // Cards re-render (and may settle) after a fetch, so check again when the timer fires.
    if (waiting.size > 0) void fetchLog();
  }, failed ? RETRY_MS : POLL_MS);
}

async function fetchLog(): Promise<void> {
  timer = null;
  if (inflight || !activeRpc) return;
  inflight = true;
  const gen = generation;
  try {
    const r = await activeRpc.call("speechLog");
    if (gen !== generation) return;
    entries = r.entries;
    failed = false;
  } catch {
    if (gen !== generation) return;
    failed = true; // keep the last entries; cards keep their last state
  }
  inflight = false;
  for (const notify of listeners) notify();
  schedule();
}

export function refreshSpeechLog(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  void fetchLog();
}

const onVisible = () => {
  if (document.visibilityState === "visible") refreshSpeechLog();
};

export function useSpeechLog(pending: boolean): SpeechLogEntry[] | null {
  const rpc = useRpc<typeof rpcContract>();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const token = useMemo(() => Symbol("kokoro-card"), []);
  useEffect(() => {
    activeRpc = rpc;
    if (listeners.size === 0) document.addEventListener("visibilitychange", onVisible);
    listeners.add(rerender);
    refreshSpeechLog();
    return () => {
      listeners.delete(rerender);
      waiting.delete(token);
      if (listeners.size === 0) document.removeEventListener("visibilitychange", onVisible);
    };
  }, [rpc, token]);
  useEffect(() => {
    if (pending) {
      waiting.add(token);
      schedule();
    } else {
      waiting.delete(token);
    }
  }, [pending, token]);
  return entries;
}

/** Tests only: forget the shared poll between renders. */
export function resetSpeechLogForTests(): void {
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  inflight = false;
  failed = false;
  entries = null;
  activeRpc = null;
  waiting.clear();
  listeners.clear();
  document.removeEventListener("visibilitychange", onVisible);
}
