import type { HealthResult, ServerResult } from "../schemas.ts";

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
