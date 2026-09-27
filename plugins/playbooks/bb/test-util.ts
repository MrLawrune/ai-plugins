import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, type SqlDb } from "./server/store.ts";
import { readFileSync } from "node:fs";
import type { StandardSchemaV1InferInput } from "@get-bb/plugin-sdk";
import type { HostContract } from "./host-contract.ts";
import type { HostClient } from "./server/runs.ts";

export const loadText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export const loadFixture = (name: string): unknown => JSON.parse(loadText(name));

export const loadLines = (name: string): string[] =>
  loadText(name)
    .split("\n")
    .filter((l) => l.trim().length > 0);

/** Parse a `-j` runner stream: JSON lines become events, anything else is a raw line. */
export const parseRunnerLines = (lines: string[]): { events: Record<string, unknown>[]; raw: string[] } => {
  const events: Record<string, unknown>[] = [];
  const raw: string[] = [];
  for (const line of lines) {
    if (line.startsWith("{")) {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } else {
      raw.push(line);
    }
  }
  return { events, raw };
};

/** In-memory database with the store's migrations applied (node:sqlite stands in for the host's better-sqlite3). */
export function memDb(): SqlDb {
  const db = new DatabaseSync(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db as unknown as SqlDb;
}

/** Per-method handlers for `fakeHostClient`; mutable so a test can swap one mid-flight. Outputs are not checked. */
export type HostScript = { [M in keyof HostContract & string]?: (input: StandardSchemaV1InferInput<HostContract[M]["input"]>) => Promise<unknown> };

/** A scripted stand-in for the SDK host client: records every call and answers from `script`. */
export function fakeHostClient(script: HostScript): { calls: { method: string; input: unknown }[]; script: HostScript; call: HostClient["call"] } {
  const calls: { method: string; input: unknown }[] = [];
  const call = async (method: string, input: unknown): Promise<unknown> => {
    calls.push({ method, input });
    const fn = script[method as keyof HostScript] as ((i: unknown) => Promise<unknown>) | undefined;
    if (!fn) throw new Error(`fake host: no script for ${method}`);
    return fn(input);
  };
  return { calls, script, call: call as HostClient["call"] };
}
