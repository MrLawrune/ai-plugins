// A fake BbPluginApi for driving the backend entry point (server.ts) in tests: it records what the
// plugin registers and runs the dispose callbacks the way the host does (last registered first),
// then closes the database.
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { UpstreamSocket } from "./stream-relay.ts";
import { memKv } from "./test-kv.ts";

type Handlers = Record<string, (input: never) => Promise<unknown>>;
type AiService = { transcribe: (audio: File, opts: { signal: AbortSignal; hint: string | null }) => Promise<string> };

export interface FakeBbOptions {
  kv?: ReturnType<typeof memKv>;
  /** Replaces `bb.storage.database()`. */
  database?: () => Database.Database;
  migrate?: (db: Database.Database, statements: string[]) => void;
  serverUrl?: string;
}

export function fakeBb(opts: FakeBbOptions = {}) {
  const kv = opts.kv ?? memKv();
  const db = new Database(":memory:");
  const disposers: Array<() => void | Promise<void>> = [];
  const logs = { warn: [] as string[], info: [] as string[] };
  const reg = { rpc: null as unknown as Handlers, ai: null as unknown as AiService, ws: null as unknown, services: new Map<string, { start(signal: AbortSignal): Promise<void> }>() };
  let values: { serverUrl: string; apiKey?: string } = { serverUrl: opts.serverUrl ?? "https://stt.example" };
  const listeners: Array<(v: typeof values) => void> = [];
  const bb = {
    onDispose: (fn: () => void | Promise<void>) => void disposers.push(fn),
    settings: {
      define: () => ({
        get: async () => ({ ...values }),
        experimental_set: async (patch: Record<string, string | null>) => {
          values = { ...values, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? ""])) };
          return { ...values };
        },
        onChange: (fn: (v: typeof values) => void) => void listeners.push(fn),
      }),
    },
    status: { needsConfiguration: () => {} },
    storage: {
      kv,
      database: opts.database ?? (() => db),
      migrate: opts.migrate ?? ((d: Database.Database, statements: string[]) => { for (const sql of statements) d.exec(sql); }),
    },
    log: { warn: (m: string) => void logs.warn.push(m), info: (m: string) => void logs.info.push(m) },
    background: { service: (name: string, s: { start(signal: AbortSignal): Promise<void> }) => void reg.services.set(name, s) },
    rpc: { register: (_contract: unknown, handlers: Handlers) => { reg.rpc = handlers; } },
    http: { experimental_websocket: (_path: string, h: unknown) => { reg.ws = h; }, route: () => {} },
    experimental_aiServices: { register: (d: AiService) => { reg.ai = d; } },
  };
  return {
    bb: bb as unknown as BbPluginApi,
    kv, db, logs, reg,
    /** The upstream sockets the relay opened. */
    upstreams: [] as UpstreamSocket[],
    /** What the host does on unload: dispose callbacks, then the database closes. */
    async dispose() {
      for (const fn of [...disposers].reverse()) await fn();
      if (db.open) db.close();
    },
  };
}
