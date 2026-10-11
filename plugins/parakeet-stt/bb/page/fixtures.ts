import { DEFAULT_PREFS } from "../prefs.ts";
import { MODEL_LOADING, type DeviceRecord, type HealthResult, type HistoryEntry, type Prefs, type ProfileInfo, type ServerResult } from "../schemas.ts";

export const UP: HealthResult = {
  configured: true, up: true, model: "parakeet-tdt-0.6b", version: "1.4.0", error: null, lastLatencyMs: 320,
};
export const NOT_SET_UP: HealthResult = {
  configured: false, up: false, model: null, version: null, error: null, lastLatencyMs: null,
};
export const DOWN: HealthResult = {
  configured: true, up: false, model: null, version: null, error: "connection refused", lastLatencyMs: null,
};

export const SERVER: ServerResult = { serverUrl: "https://stt.example", apiKeySet: false, needsReload: false };
export const LOADING: HealthResult = {
  configured: true, up: false, model: "parakeet-tdt-0.6b", version: "1.4.0", error: MODEL_LOADING, lastLatencyMs: null,
};

export const ME: DeviceRecord = { id: "dev-1", name: "Linux PC", kind: "desktop", profileId: "desktop", lastSeen: 1_000 };
export const PROFILES: ProfileInfo[] = [{ id: "desktop", name: "Desktop" }, { id: "touch", name: "Touch screen" }];
export const ENTRIES: HistoryEntry[] = [
  { id: 1, text: "older words", at: 1_000, durationMs: 800, source: "oneshot" },
  { id: 3, text: "newest words", at: 3_000, durationMs: 1200, source: "stream" },
  { id: 2, text: "spoken to the agent", at: 2_000, durationMs: 900, source: "voice" },
];

/** Every RPC the dictation panel calls, answering as a working server; override per test. */
type Handlers = Record<string, (input: never) => unknown>;
export function panelStubs(overrides: Handlers = {}): Record<string, (input: unknown) => unknown> {
  const stubs: Handlers = {
    hello: () => ({ device: ME, prefs: DEFAULT_PREFS }),
    listProfiles: () => ({ profiles: PROFILES, devices: [ME] }),
    getPrefs: () => DEFAULT_PREFS,
    setPrefs: ({ patch }: { patch: Partial<Prefs> }) => ({ ...DEFAULT_PREFS, ...patch }),
    health: () => UP,
    listHistory: () => ({ entries: ENTRIES }),
    clearHistory: () => ({ cleared: true }),
    getNote: () => ({ note: null }),
    dismissNote: () => ({ dismissed: true }),
    ...overrides,
  };
  return stubs as Record<string, (input: unknown) => unknown>;
}

/** Stubs for a profile whose prefs differ from the defaults. */
export function withPrefs(p: Partial<Prefs>): Handlers {
  const prefs = { ...DEFAULT_PREFS, ...p };
  return {
    hello: () => ({ device: ME, prefs }),
    getPrefs: () => prefs,
    setPrefs: ({ patch }: { patch: Partial<Prefs> }) => ({ ...prefs, ...patch }),
  };
}
