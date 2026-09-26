// Constants shared by backend and frontend. No Node or zod imports: the browser bundle loads this.
export const ENV_KINDS = ["lab", "dev", "staging", "prod", "customer", "other"] as const;
export type EnvKind = (typeof ENV_KINDS)[number];
export const RULES_MAX = 4096;

/** Realtime channels published by the backend. Payloads carry ids only; the UI refetches over RPC. */
export const CHANNELS = { changed: "infra:changed", activity: "infra:activity", events: "infra:events" } as const;

/** Poll interval defaults by environment kind: lab work is live, production and customer systems are polled politely. */
export const DEFAULT_POLL_SECONDS: Record<EnvKind, number> = { lab: 10, dev: 10, staging: 30, prod: 60, customer: 60, other: 30 };
