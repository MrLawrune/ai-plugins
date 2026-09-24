import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { KokoroClient } from "./kokoro-client.ts";
import { PrefsStore } from "./prefs.ts";
import { installerFailure, registerRpc } from "./rpc.ts";

function harness() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const stops: (string | null)[] = [];
  const client: KokoroClient = {
    baseUrl: "http://127.0.0.1:6789",
    async call<T>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (path === "/mute") return { muted: (body as { muted: boolean }).muted } as T;
      return { sessions_cancelled: 0 } as T;
    },
    async *synthesize() {},
  };
  const host = createFakePluginHost();
  registerRpc(host.bb, {
    client: () => client,
    supervisor: () => null,
    prefs: new PrefsStore(host.bb.storage.kv),
    hub: { clients: () => [], stop: (sessionId) => { stops.push(sessionId); } },
    log: host.bb.log,
  });
  return { host, calls, stops };
}

test("Stop all also stops browser playback", async () => {
  const { host, calls, stops } = harness();
  await host.harness.callRpc("interruptAll", null);
  assert.deepEqual(stops, [null]);
  assert.deepEqual(calls.map((c) => c.path), ["/interrupt-all"]);
});

test("Mute also stops browser playback; unmute does not", async () => {
  const { host, stops } = harness();
  assert.deepEqual(await host.harness.callRpc("setMuted", { muted: true }), { muted: true });
  assert.deepEqual(stops, [null]);
  await host.harness.callRpc("setMuted", { muted: false });
  assert.deepEqual(stops, [null]);
});

test("installerFailure keeps the last lines of the installer output", () => {
  const out = "downloading uv\n\nerror: curl: (6) Could not resolve host: astral.sh\n";
  assert.equal(
    installerFailure(1, out),
    "the installer exited with code 1 (downloading uv error: curl: (6) Could not resolve host: astral.sh).",
  );
  assert.equal(installerFailure(127, ""), "the installer exited with code 127.");
  assert.ok(installerFailure(1, "x".repeat(1000)).length < 360);
});
