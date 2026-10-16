import { test } from "node:test";
import assert from "node:assert/strict";
import { createServerConfig } from "./server-config.ts";
import type { SttClient } from "./stt-client.ts";

test("the client is rebuilt only when the server settings change", () => {
  const built: string[] = [];
  const config = createServerConfig({ serverUrl: "https://a.example", apiKey: "k" }, (c) => { built.push(`${c.serverUrl}|${c.apiKey}`); return {} as SttClient; });
  assert.deepEqual(built, ["https://a.example|k"]);
  config.apply({ serverUrl: "https://a.example", apiKey: "k" });
  assert.equal(built.length, 1, "same values: no second client");
  config.apply({ serverUrl: "https://b.example", apiKey: undefined });
  assert.deepEqual(built.slice(1), ["https://b.example|"]);
  assert.deepEqual(config.current(), { serverUrl: "https://b.example", apiKey: undefined });
  assert.equal(config.configured(), true);
  config.apply({ serverUrl: "  ", apiKey: "" });
  assert.equal(config.configured(), false);
});
