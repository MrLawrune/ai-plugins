// The server's only doorway to the host entry. `overrideCommand` is a test-only escape hatch in the host
// contract (it runs an arbitrary string on the BB machine); it must never leave the server, whoever set it.
import type { HostClient } from "./runs.ts";

/** A copy of `input` without `overrideCommand`; a missing or non-object input becomes `{}` so the host's schema reports it. */
export function stripOverride(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
  const { overrideCommand: _dropped, ...safe } = input as Record<string, unknown>;
  return safe;
}

export function safeHostClient(raw: { call(method: never, input: never, options: never): Promise<unknown> }): HostClient {
  return {
    call: ((method: never, input: unknown, options: never) => raw.call(method, stripOverride(input) as never, options)) as HostClient["call"],
  };
}
