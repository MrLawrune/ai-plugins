// Shared state for the Kokoro panel, its header, and the server settings section.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../contract.ts";
import {
  configResponseSchema,
  prefsSchema,
  runtimeConfigSchema,
  type ConfigResponse,
  type KokoroStatus,
  type Prefs,
  type RuntimePatch,
  type SettingsPatch,
} from "../schemas.ts";
import { errorText } from "../util.ts";
import { createPatchQueue, type SaveState } from "./patch-queue.ts";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
/** Speech settings or engine-runtime keys; useConfig sends the two kinds in separate calls. */
export type ConfigPatch = SettingsPatch & RuntimePatch;

const RUNTIME_KEYS = new Set<string>(Object.keys(runtimeConfigSchema.shape));

function split(p: ConfigPatch): { settings: SettingsPatch; runtime: RuntimePatch } {
  const settings: Record<string, unknown> = {};
  const runtime: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) (RUNTIME_KEYS.has(k) ? runtime : settings)[k] = v;
  return { settings, runtime };
}

const empty = (o: object) => Object.keys(o).length === 0;

/** One indicator for both queues: an error wins, then saving, then saved. */
function combine(a: SaveState, b: SaveState): SaveState {
  for (const kind of ["error", "saving", "saved"] as const) {
    if (a.kind === kind) return a;
    if (b.kind === kind) return b;
  }
  return a;
}

// --- status: one poll shared by every mounted surface ---

const subscribers = new Set<(s: KokoroStatus | null) => void>();
let latest: KokoroStatus | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let activeRpc: Rpc | null = null;
let failures = 0;
/** Consecutive failed polls before the last known status is dropped as stale. */
const STALE_AFTER = 2;
/** Bumped by resetStatusForTests so an in-flight poll from a previous mount is ignored. */
let generation = 0;

const settled = (s: KokoroStatus | null) => s !== null && (s.setup.state === "running" || s.setup.state === "external");

async function poll(): Promise<void> {
  timer = null;
  if (polling || !activeRpc || subscribers.size === 0) return;
  polling = true;
  const gen = generation;
  let next = latest;
  try {
    next = await activeRpc.call("status");
    failures = 0;
  } catch {
    // Ride out a blip on the last known status, but a backend that keeps failing is not "Ready".
    if (++failures >= STALE_AFTER) next = null;
  }
  if (gen !== generation) return;
  polling = false;
  latest = next;
  for (const notify of subscribers) notify(latest);
  if (subscribers.size > 0) timer = setTimeout(() => void poll(), settled(latest) ? 3_000 : 1_000);
}

/** Tests only: forget the shared poll between renders. */
export function resetStatusForTests(): void {
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  polling = false;
  latest = null;
  failures = 0;
  activeRpc = null;
  subscribers.clear();
}

/** Some engine, main or backup, answers: speech can play and voices can be listed. */
export function anyEngineUp(s: KokoroStatus | null): boolean {
  return s?.engines.some((e) => e.health.up) ?? false;
}

/** The managed local engine (in either slot) answers: its runtime can be read. */
export function localEngineUp(s: KokoroStatus | null): boolean {
  return s?.engines.some((e) => e.local && e.health.up) ?? false;
}

export function refreshStatus(): void {
  if (timer) clearTimeout(timer);
  void poll();
}

export function useStatus(): KokoroStatus | null {
  const rpc = useRpc<typeof rpcContract>();
  const [s, setS] = useState(latest);
  useEffect(() => {
    activeRpc = rpc;
    subscribers.add(setS);
    if (!timer && !polling) void poll();
    return () => {
      subscribers.delete(setS);
      if (subscribers.size === 0 && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [rpc]);
  return s;
}

// --- one-shot loads that retry when their precondition comes (back) true ---

export function useLoaded<T>(load: () => Promise<T>, when: boolean) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setValue(await load());
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [load]);
  useEffect(() => {
    if (when) void reload();
  }, [when, reload]);
  return { value, error, reload };
}

// --- config: confirmed server state plus local drafts still being saved ---

const omit = <T extends object>(obj: T, keys: (keyof T)[]): T => {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

/**
 * Settings are plugin-owned and load even while every engine is down; they
 * reload when the local engine's reachability changes, since only while it
 * answers is its runtime known.
 */
export function useConfig(localUp: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirmed, setConfirmed] = useState<ConfigResponse | null>(null);
  const [drafts, setDrafts] = useState<SettingsPatch>({});
  const [runtimeDrafts, setRuntimeDrafts] = useState<RuntimePatch>({});
  const [settingsSave, setSettingsSave] = useState<SaveState>({ kind: "idle" });
  const [runtimeSave, setRuntimeSave] = useState<SaveState>({ kind: "idle" });
  // `localUp` is a dependency only so the load reruns when the local engine comes up or goes down.
  const load = useCallback(() => rpc.call("getConfig"), [rpc, localUp]);
  const loaded = useLoaded(load, true);
  useEffect(() => { if (loaded.value) setConfirmed(loaded.value); }, [loaded.value]);

  // The server rejects a patch that mixes the two kinds, so each kind has its own queue.
  const settingsQueue = useMemo(() => createPatchQueue<SettingsPatch, ConfigResponse>({
    send: (p) => rpc.call("patchConfig", p),
    onCommitted: (r, keys) => {
      setConfirmed(r);
      setDrafts((d) => omit(d, keys));
    },
    onFailed: (keys) => setDrafts((d) => omit(d, keys)),
    onState: setSettingsSave,
  }), [rpc]);
  const runtimeQueue = useMemo(() => createPatchQueue<RuntimePatch, ConfigResponse>({
    send: (p) => rpc.call("patchConfig", p),
    onCommitted: (r, keys) => {
      setConfirmed(r);
      setRuntimeDrafts((d) => omit(d, keys));
    },
    onFailed: (keys) => setRuntimeDrafts((d) => omit(d, keys)),
    onState: setRuntimeSave,
  }), [rpc]);
  const flush = useCallback(
    () => Promise.all([settingsQueue.flush(), runtimeQueue.flush()]).then(() => undefined),
    [settingsQueue, runtimeQueue],
  );
  // Leaving the page mid-drag still saves the last value.
  useEffect(() => () => { void flush(); }, [flush]);

  useRealtime("kokoro-config", (payload) => {
    const r = configResponseSchema.safeParse(payload);
    if (r.success) setConfirmed(r.data);
  });

  const patch = useCallback((p: ConfigPatch, debounceMs = 0) => {
    const { settings, runtime } = split(p);
    if (!empty(settings)) {
      setDrafts((d) => ({ ...d, ...settings }));
      settingsQueue.set(settings, debounceMs);
    }
    if (!empty(runtime)) {
      setRuntimeDrafts((d) => ({ ...d, ...runtime }));
      runtimeQueue.set(runtime, debounceMs);
    }
  }, [settingsQueue, runtimeQueue]);

  /** Apply now and throw on failure: for engine changes the caller reports inline. One kind per call. */
  const commit = useCallback(async (p: SettingsPatch | RuntimePatch) => {
    await flush();
    setConfirmed(await rpc.call("patchConfig", p));
  }, [flush, rpc]);

  const dismissNote = useCallback(async () => {
    try {
      await rpc.call("dismissNote");
      setConfirmed((c) => (c ? { ...c, note: null } : c));
    } catch (cause) {
      toast.error(`Kokoro: ${errorText(cause)}`);
    }
  }, [rpc]);

  const data = useMemo((): ConfigResponse | null => {
    if (!confirmed) return null;
    const { runtime } = confirmed;
    return {
      ...confirmed,
      config: { ...confirmed.config, ...drafts },
      runtime: runtime ? { ...runtime, config: { ...runtime.config, ...runtimeDrafts } } : null,
    };
  }, [confirmed, drafts, runtimeDrafts]);
  const save = combine(settingsSave, runtimeSave);
  return { data, error: loaded.error, reload: loaded.reload, patch, commit, dismissNote, save };
}

// --- prefs (bb-side; the backend serializes writes) ---

export function usePrefs() {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => rpc.call("getPrefs"), [rpc]);
  const { value, error, reload } = useLoaded(load, true);
  const [prefs, setPrefsState] = useState<Prefs | null>(null);
  useEffect(() => { if (value) setPrefsState(value); }, [value]);
  useRealtime("kokoro-prefs", (payload) => {
    const r = prefsSchema.safeParse(payload);
    if (r.success) setPrefsState(r.data);
  });
  const setPrefs = useCallback(async (patch: Partial<Prefs>) => {
    setPrefsState((p) => (p ? { ...p, ...patch } : p));
    try {
      setPrefsState(await rpc.call("setPrefs", patch));
      return true;
    } catch (cause) {
      // The backend serializes writes, so its copy is authoritative: reload it.
      toast.error(`Kokoro: ${errorText(cause)}`);
      await reload();
      return false;
    }
  }, [rpc, reload]);
  return { prefs, error, reload, setPrefs };
}

// --- global controls ---

export function useControls() {
  const rpc = useRpc<typeof rpcContract>();
  const setMuted = useCallback(async (muted: boolean) => {
    try {
      await rpc.call("setMuted", { muted });
    } catch (cause) {
      toast.error(`Kokoro: ${errorText(cause)}`);
    }
    refreshStatus();
  }, [rpc]);
  const stopAll = useCallback(async () => {
    try {
      await rpc.call("interruptAll");
      toast.success("Stopped playback");
    } catch (cause) {
      toast.error(`Kokoro: ${errorText(cause)}`);
    }
  }, [rpc]);
  return { setMuted, stopAll };
}
