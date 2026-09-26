import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { KokoroClient } from "./kokoro-client.ts";
import { PrefsStore } from "./prefs.ts";
import { installerFailure, registerRpc } from "./rpc.ts";
import type { KokoroStatus } from "./schemas.ts";
import { CONFIG_RESPONSE, HEALTH } from "./page/fixtures.ts";

function harness(playback: "client" | "server" = "server", ready = true) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const stops: (string | null)[] = [];
  const spoken: unknown[][] = [];
  const sounds: unknown[][] = [];
  const published: [string, unknown][] = [];
  const client: KokoroClient = {
    baseUrl: "http://127.0.0.1:6789",
    async call<T>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (path === "/mute") return { muted: (body as { muted: boolean }).muted } as T;
      if (path === "/health") return HEALTH as T;
      if (method === "PATCH" && path === "/config") return { ...CONFIG_RESPONSE, config: { ...CONFIG_RESPONSE.config, ...(body as object) } } as T;
      if (path === "/config") return { config: { speech_gain: 0.8, sound_volume: 0.6 } } as T;
      return { sessions_cancelled: 0, status: "playing" } as T;
    },
    async *synthesize() {},
  };
  const host = createFakePluginHost();
  const prefs = new PrefsStore(host.bb.storage.kv);
  registerRpc(host.bb, {
    client: () => client,
    supervisor: () => null,
    prefs,
    hub: {
      clients: () => [],
      stop: (sessionId) => { stops.push(sessionId); },
      speak: (...a) => { spoken.push(a); },
      sound: (...a) => { sounds.push(a); },
      hasReadyClient: () => ready,
    },
    log: host.bb.log,
    publish: (c, p) => { published.push([c, p]); },
  });
  return { host, calls, stops, spoken, sounds, published, ready: prefs.update({ playback }) };
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

test("preview plays in the browser when browser playback is selected", async () => {
  const h = harness("client");
  await h.ready;
  assert.deepEqual(await h.host.harness.callRpc("preview", { voice: "af_bella", speed: 1.2 }), { status: "playing" });
  assert.equal(h.calls.some((c) => c.path === "/preview"), false);
  const [entryId, text, session, gain, opts] = h.spoken[0] as [number, string, string, number, unknown];
  assert.ok(entryId >= 0xf000_0000);
  assert.equal(text, "This is how I will sound when reading your updates.");
  assert.equal(session, "preview");
  assert.equal(gain, 0.8);
  assert.deepEqual(opts, { voice: "af_bella", speed: 1.2 });
});

test("preview reports no_window when no browser can play", async () => {
  const h = harness("client", false);
  await h.ready;
  assert.deepEqual(await h.host.harness.callRpc("preview", {}), { status: "no_window" });
  assert.equal(h.spoken.length, 0);
});

test("preview uses the server speakers when server playback is selected", async () => {
  const h = harness("server");
  await h.ready;
  await h.host.harness.callRpc("preview", { text: "Hello" });
  assert.deepEqual(h.calls.at(-1), { method: "POST", path: "/preview", body: { text: "Hello", session_id: "preview" } });
});

test("sound tests follow browser playback at the configured cue volume", async () => {
  const h = harness("client");
  await h.ready;
  await h.host.harness.callRpc("playSound", { sound: "done" });
  assert.deepEqual(h.sounds, [["done", 0.6, "bb-preview"]]);
});

test("status bundles health, setup and clients", async () => {
  const h = harness();
  const s = (await h.host.harness.callRpc("status", null)) as KokoroStatus;
  assert.equal(s.health.up, true);
  assert.equal(s.setup.state, "error"); // no supervisor in this harness
  assert.deepEqual(s.clients, []);
});

test("a config change is published to every window", async () => {
  const h = harness();
  await h.host.harness.callRpc("patchConfig", { speed: 1.2 });
  const [channel, payload] = h.published.at(-1)!;
  assert.equal(channel, "kokoro-config");
  assert.equal((payload as typeof CONFIG_RESPONSE).config.speed, 1.2);
});
