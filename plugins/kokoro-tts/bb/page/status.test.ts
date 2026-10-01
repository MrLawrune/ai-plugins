import { test } from "node:test";
import assert from "node:assert/strict";
import type { KokoroStatus } from "../schemas.ts";
import { ownerText, statusLine } from "./status.ts";

const setup = (over: Partial<KokoroStatus["setup"]> = {}): KokoroStatus["setup"] => ({
  state: "running", detail: null, progress: null, fixCommand: null, headless: false, gpuAvailable: false, ...over,
});
const up = (over: Record<string, unknown> = {}): KokoroStatus["health"] =>
  ({ up: true, health: { status: "ok", model: "kokoro-v1.0.onnx", active_sessions: 0, ...over } }) as KokoroStatus["health"];
const down: KokoroStatus["health"] = { up: false, error: "unreachable" };
const status = (health: KokoroStatus["health"], s: KokoroStatus["setup"], muted = false): KokoroStatus =>
  ({ health, engines: [], setup: s, clients: [], muted, latency: { median_ms: null, samples: 0 } });

test("setup progress reads as progress, not an outage", () => {
  assert.deepEqual(statusLine(status(down, setup({ state: "downloading-models", progress: 0.42 }))),
    { tone: "busy", text: "Downloading voice model 42%" });
  assert.equal(statusLine(status(down, setup({ state: "installing-runtime" }))).text, "Installing runtime");
  assert.equal(statusLine(status(down, setup({ state: "needs-uv" }))).tone, "warn");
  assert.equal(statusLine(null).text, "Checking…");
});

test("a running server reads Ready, or Muted", () => {
  assert.deepEqual(statusLine(status(up(), setup())), { tone: "ok", text: "Ready" });
  assert.deepEqual(statusLine(status(up(), setup(), true)), { tone: "warn", text: "Muted" });
});

test("an unmanaged server that is down is not an error", () => {
  assert.deepEqual(statusLine(status(down, setup({ state: "error", detail: "manage off" }))).tone, "warn");
});

test("ownerText names who started an adopted server", () => {
  assert.equal(ownerText(status(up(), setup())), "Managed by bb");
  assert.equal(ownerText(status(up({ started_by: "bb" }), setup({ state: "external" }))),
    "Started by an earlier bb session");
  assert.equal(ownerText(status(up(), setup({ state: "external" }))), "Started outside bb");
});
