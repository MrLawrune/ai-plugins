// Shared state for the settings surfaces: one health poll for every mounted consumer.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract.ts";
import type { HealthResult } from "../schemas.ts";
import { errorText } from "./ui.tsx";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

/** The poll never runs faster than this. */
export const HEALTH_POLL_MS = 5_000;

const subscribers = new Set<(h: HealthResult | null) => void>();
let latest: HealthResult | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let activeRpc: Rpc | null = null;
/** Bumped by resetHealthForTests so a call still in flight from an earlier mount is ignored. */
let generation = 0;

function check(): Promise<void> {
  if (inFlight) return inFlight;
  const rpc = activeRpc;
  if (!rpc) return Promise.resolve();
  const gen = generation;
  const run = (async () => {
    let next: HealthResult;
    try {
      next = await rpc.call("health");
    } catch (cause) {
      // The backend itself failed: show it as unreachable with the reason, keeping the last latency.
      next = { configured: true, up: false, model: null, version: null, error: errorText(cause), lastLatencyMs: latest?.lastLatencyMs ?? null };
    }
    if (gen !== generation) return;
    latest = next;
    for (const notify of subscribers) notify(next);
  })().finally(() => { if (gen === generation) inFlight = null; });
  inFlight = run;
  return run;
}

/** Force one health call now; the shared interval keeps its own schedule. */
export function refreshHealth(): Promise<void> {
  return check();
}

/** Tests only: forget the shared poll between renders. */
export function resetHealthForTests(): void {
  generation++;
  if (interval) clearInterval(interval);
  interval = null;
  inFlight = null;
  latest = null;
  activeRpc = null;
  subscribers.clear();
}

/** The server's health, polled every 5 s while any component uses it and not at all otherwise. */
export function useHealth(): HealthResult | null {
  const rpc = useRpc<typeof rpcContract>();
  const [health, setHealth] = useState(latest);
  useEffect(() => {
    activeRpc = rpc;
    subscribers.add(setHealth);
    if (interval === null) {
      void check();
      interval = setInterval(() => void check(), HEALTH_POLL_MS);
    }
    return () => {
      subscribers.delete(setHealth);
      if (subscribers.size === 0) {
        if (interval) clearInterval(interval);
        interval = null;
      }
    };
  }, [rpc]);
  return health;
}
