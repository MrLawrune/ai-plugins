// Config edits from the settings UI: per-field debounce merged into one batch,
// one request in flight, rollback limited to the keys a failed batch owned, and a Retry that
// resends only the values still failed (a later value for a key replaces its failure).

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string; retry: () => void };

export interface PatchQueue<P extends object> {
  set(patch: Partial<P>, debounceMs?: number): void;
  flush(): Promise<void>;
  isPending(key: keyof P): boolean;
}

export function createPatchQueue<P extends object, R>(deps: {
  send: (patch: Partial<P>) => Promise<R>;
  onCommitted: (result: R, keys: (keyof P)[]) => void;
  onFailed: (keys: (keyof P)[], message: string) => void;
  onState: (state: SaveState) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): PatchQueue<P> {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let pending: Partial<P> = {};
  let timer: unknown = null;
  let draining: Promise<void> | null = null;
  /** Latest failed value per key, until a later value for the key is set (and so saved or failed in its place). */
  let failures: Partial<P> = {};
  let failureMessage = "";

  const stillOwned = (batch: Partial<P>) => (Object.keys(batch) as (keyof P)[]).filter((k) => !(k in pending));
  const failedState = (): SaveState => ({
    kind: "error",
    message: failureMessage,
    retry: () => { if (Object.keys(failures).length > 0) set({ ...failures }); },
  });

  async function drain(): Promise<void> {
    while (Object.keys(pending).length > 0) {
      const batch = pending;
      pending = {};
      deps.onState({ kind: "saving" });
      try {
        const result = await deps.send(batch);
        deps.onCommitted(result, stillOwned(batch));
      } catch (cause) {
        failureMessage = cause instanceof Error ? cause.message : String(cause);
        const owned = stillOwned(batch);
        deps.onFailed(owned, failureMessage);
        for (const k of owned) failures[k] = batch[k];
      }
    }
    deps.onState(Object.keys(failures).length > 0 ? failedState() : { kind: "saved" });
  }

  function flush(): Promise<void> {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    draining ??= drain().finally(() => { draining = null; });
    return draining;
  }

  function set(patch: Partial<P>, debounceMs = 0): void {
    pending = { ...pending, ...patch };
    for (const k of Object.keys(patch) as (keyof P)[]) delete failures[k];
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (debounceMs > 0) timer = setTimer(() => { timer = null; void flush(); }, debounceMs);
    else void flush();
  }

  return { set, flush, isPending: (key) => key in pending };
}
