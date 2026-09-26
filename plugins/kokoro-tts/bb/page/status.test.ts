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

test("setup progress reads as progress, not an outage", () => {
  assert.deepEqual(statusLine({ health: down, setup: setup({ state: "downloading-models", progress: 0.42 }), clients: [] }),
    { tone: "busy", text: "Downloading voice model 42%" });
  assert.equal(statusLine({ health: down, setup: setup({ state: "installing-runtime" }), clients: [] }).text, "Installing runtime");
  assert.equal(statusLine({ health: down, setup: setup({ state: "needs-uv" }), clients: [] }).tone, "warn");
  assert.equal(statusLine(null).text, "Checking…");
});

test("a running server reads Ready, or Muted", () => {
  assert.deepEqual(statusLine({ health: up(), setup: setup(), clients: [] }), { tone: "ok", text: "Ready" });
  assert.deepEqual(statusLine({ health: up({ muted: true }), setup: setup(), clients: [] }), { tone: "warn", text: "Muted" });
});

test("an unmanaged server that is down is not an error", () => {
  assert.deepEqual(statusLine({ health: down, setup: setup({ state: "error", detail: "manage off" }), clients: [] }).tone, "warn");
});

test("ownerText names who started an adopted server", () => {
  assert.equal(ownerText({ health: up(), setup: setup(), clients: [] }), "Managed by bb");
  assert.equal(ownerText({ health: up({ started_by: "claude-code" }), setup: setup({ state: "external" }), clients: [] }),
    "Started by the Claude Code hooks");
  assert.equal(ownerText({ health: up(), setup: setup({ state: "external" }), clients: [] }), "Started outside bb");
});
