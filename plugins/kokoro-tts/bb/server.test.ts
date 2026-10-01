import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { NOTE_UNREADABLE } from "./coord/migrate.ts";
import { DEFAULT_SETTINGS, type Settings } from "./schemas.ts";
import plugin, { isLocalRequest } from "./server.ts";
import { tmpDir } from "./test-tmp.ts";

/** A loopback URL nothing listens on, so no real Kokoro server is touched. */
let deadUrl = "";
let savedKokoroConfig: string | undefined;

before(async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  deadUrl = `http://127.0.0.1:${port}`;
  // Migration falls back to the old config file; point it at one that does not exist.
  savedKokoroConfig = process.env.KOKORO_CONFIG;
  process.env.KOKORO_CONFIG = path.join(tmpDir("kokoro-server-test-"), "missing.json");
});

after(() => {
  if (savedKokoroConfig === undefined) delete process.env.KOKORO_CONFIG;
  else process.env.KOKORO_CONFIG = savedKokoroConfig;
});

async function load() {
  const host = createFakePluginHost({ settings: { serverUrl: deadUrl } });
  await plugin(host.bb);
  return host;
}

const waitFor = async (pred: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

test("with no Kokoro server reachable the plugin loads on defaults with a note, and registers its routes", async () => {
  const host = await load();
  try {
    assert.deepEqual(await host.bb.storage.kv.get("settings"), DEFAULT_SETTINGS);
    assert.equal(await host.bb.storage.kv.get("migration-note"), NOTE_UNREADABLE);
    const routes = host.harness.registrations.httpRoutes.map((r) => `${r.method} ${r.path}`);
    assert.ok(routes.includes("GET /sound/attention"), routes.join(", "));
    assert.deepEqual(host.harness.registrations.websocketRoutes.map((r) => r.path), ["/player"]);
    const res = await host.harness.fetchHttp("GET", "/sound/done");
    assert.equal(res.headers.get("content-type"), "audio/wav");
  } finally {
    await host.harness.dispose();
  }
});

test("existing settings are kept: migration runs once", async () => {
  const host = createFakePluginHost({ settings: { serverUrl: deadUrl } });
  try {
    const mine: Settings = { ...DEFAULT_SETTINGS, voice: "bm_george", speed: 1.2 };
    await host.bb.storage.kv.set("settings", mine);
    await plugin(host.bb);
    assert.deepEqual(await host.bb.storage.kv.get("settings"), mine);
    assert.equal(await host.bb.storage.kv.get("migration-note"), undefined);
  } finally {
    await host.harness.dispose();
  }
});

test("retention change prunes now", async () => {
  const host = await load();
  try {
    const db = host.bb.storage.database();
    const insert = db.prepare("INSERT INTO speech_log (ts, session_id, text, status) VALUES (?, ?, ?, 'done')");
    const ts = Date.now() / 1000;
    db.transaction(() => { for (let i = 0; i < 300; i++) insert.run(ts, `t${i % 7}`, `Line ${i}.`); })();
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM speech_log").get() as { n: number }).n;
    assert.equal(count(), 300);
    await host.harness.callRpc("patchConfig", { retention: { maxAgeDays: 7, maxEntries: 100 } });
    assert.equal(count(), 100, "without waiting for the hourly service");
  } finally {
    await host.harness.dispose();
  }
});

test("no engine reachable and no backup: the reply is logged unreachable and the error cue plays", async () => {
  const host = await load();
  try {
    const socket = await host.harness.experimental_openWebSocket("/player");
    await socket.receive(JSON.stringify({ type: "hello", clientId: "w1", deviceName: "Desk", focusedAt: 1, audioUnlocked: true }));
    assert.deepEqual(await host.harness.callRpc("replay", { threadId: "t1", text: "Hello there." }), { status: "playing" });
    const messages = () => socket.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as { type: string; sound?: string });
    await waitFor(() => messages().some((m) => m.type === "sound"));
    assert.ok(messages().some((m) => m.type === "sound" && m.sound === "error"), JSON.stringify(messages()));
    const log = (await host.harness.callRpc("speechLog", { threadId: "t1" })) as { entries: { status: string; error?: string }[] };
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0]!.status, "error");
    assert.match(log.entries[0]!.error ?? "", /^unreachable/);
  } finally {
    await host.harness.dispose();
  }
});

test("a player socket is local when its browser's address is this computer's", () => {
  const ours = new Set(["127.0.0.1", "::1", "192.0.2.10"]);
  const h = (o: Record<string, string> = {}) => new Headers(o);
  const url = new URL("http://localhost:4000/x");
  assert.equal(isLocalRequest(url, h(), ours), true, "direct loopback");
  assert.equal(isLocalRequest(new URL("http://[::1]:4000/x"), h(), ours), true);
  assert.equal(isLocalRequest(url, h({ "x-forwarded-for": "192.0.2.10" }), ours), true, "desktop via the reverse proxy");
  assert.equal(isLocalRequest(url, h({ "x-forwarded-for": "::ffff:192.0.2.10, 198.51.100.1" }), ours), true);
  assert.equal(isLocalRequest(url, h({ "x-forwarded-for": "192.0.2.77" }), ours), false, "a phone via the proxy");
  assert.equal(isLocalRequest(new URL("https://bb.example.com/x"), h(), ours), false);
});
