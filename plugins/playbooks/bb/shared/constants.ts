// Constants shared by backend, host, and frontend. No Node or zod imports: the browser bundle loads this.
export const ENV_KINDS = ["lab", "dev", "staging", "prod", "customer", "other"] as const;
export type EnvKind = (typeof ENV_KINDS)[number];
export const RULES_MAX = 4096;
export const CHANNELS = { changed: "playbooks:changed", run: "playbooks:run" } as const;
export const BUDGETS = { addToChat: 4096, newThread: 8192, investigate: 12288, rules: 600, excerpt: 2048, errorTail: 4096, res: 2048, instruction: 4096 } as const;
export const LIMITS = { msg: 2048, res: 8192, diff: 65536, stdout: 4096, lastLine: 200, error: 2048, readFile: 1_048_576, libraryFiles: 500 } as const;
export const RETENTION_DAYS = 90;
export const KIND_COLORS: Record<EnvKind, string> = { lab: "#22c55e", dev: "#3b82f6", staging: "#f59e0b", prod: "#ef4444", customer: "#a855f7", other: "#64748b" };
