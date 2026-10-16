// The server connection settings and the client built from them. Settings reach it from the RPC that
// saved them and from bb's change listener; a value that did not change builds no second client.
import { createSttClient, type SttClient, type SttConfig } from "./stt-client.ts";

export interface ServerValues { serverUrl: string; apiKey?: string }

export function createServerConfig(initial: ServerValues, build: (config: SttConfig) => SttClient = createSttClient) {
  const make = (v: ServerValues) => build({ serverUrl: v.serverUrl, apiKey: v.apiKey ?? "" });
  let current = initial;
  let client = make(initial);
  return {
    current: (): ServerValues => current,
    client: (): SttClient => client,
    configured: (): boolean => current.serverUrl.trim() !== "",
    apply(next: ServerValues): void {
      const same = next.serverUrl === current.serverUrl && (next.apiKey ?? "") === (current.apiKey ?? "");
      current = next;
      if (!same) client = make(next);
    },
  };
}
