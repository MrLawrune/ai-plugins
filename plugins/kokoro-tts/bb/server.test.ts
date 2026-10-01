import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as path from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { NOTE_LOCAL_SWITCH_FAILED, NOTE_UNREADABLE } from "./coord/migrate.ts";
import { DEFAULT_SETTINGS, type Settings } from "./schemas.ts";
import plugin, { createPlugin, enginesChange, isLocalRequest } from "./server.ts";
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

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!(await pred()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
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

async function playerSocket(host: Awaited<ReturnType<typeof load>>) {
  const socket = await host.harness.experimental_openWebSocket("/player");
  await socket.receive(JSON.stringify({ type: "hello", clientId: "w1", deviceName: "Desk", focusedAt: 1, audioUnlocked: true }));
  const messages = () => socket.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as { type: string; sound?: string });
  return { messages };
}

async function lastEntry(host: Awaited<ReturnType<typeof load>>, threadId: string) {
  const log = (await host.harness.callRpc("speechLog", { threadId })) as { entries: { status: string; error?: string }[] };
  return log.entries.at(-1);
}

test("no engine reachable and no backup: the reply is logged unreachable and the error cue plays", async () => {
  const host = await load();
  try {
    const { messages } = await playerSocket(host);
    await host.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "t1", parentThreadId: null, projectId: "p1" }), lastAssistantText: "Hello there.",
    });
    await waitFor(() => messages().some((m) => m.type === "sound"));
    assert.ok(messages().some((m) => m.type === "sound" && m.sound === "error"), JSON.stringify(messages()));
    const entry = await lastEntry(host, "t1");
    assert.equal(entry?.status, "error");
    assert.match(entry?.error ?? "", /^unreachable/);
  } finally {
    await host.harness.dispose();
  }
});

test("the error cue follows the reply's own mode: global quiet, thread brief still cues", async () => {
  const host = await load();
  try {
    await host.harness.callRpc("patchConfig", { mode: "quiet" });
    await host.harness.callRpc("setVoiceScope", { threadId: "t1", projectId: "p1", scope: "thread", patch: { mode: "brief" } });
    const { messages } = await playerSocket(host);
    await host.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "t1", parentThreadId: null, projectId: "p1" }), lastAssistantText: "Hello there.",
    });
    await waitFor(() => messages().some((m) => m.type === "sound"));
    assert.ok(messages().some((m) => m.type === "sound" && m.sound === "error"), JSON.stringify(messages()));
  } finally {
    await host.harness.dispose();
  }
});

test("a failed replay returns playing, logs the error, and plays no cue", async () => {
  const host = await load();
  try {
    const { messages } = await playerSocket(host);
    assert.deepEqual(await host.harness.callRpc("replay", { threadId: "t1", text: "Hello there." }), { status: "playing" });
    await waitFor(async () => (await lastEntry(host, "t1"))?.status === "error");
    const entry = await lastEntry(host, "t1");
    assert.equal(entry?.status, "error");
    assert.match(entry?.error ?? "", /^unreachable/);
    assert.ok(!messages().some((m) => m.type === "sound"), JSON.stringify(messages()));
  } finally {
    await host.harness.dispose();
  }
});

test("a provider switch that never answers cannot hold up loading: the note says so", async () => {
  // A fake local server (no real one is touched): its config forwards to a remote, and PATCH hangs.
  const patches: unknown[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (url === "http://127.0.0.1:6789/config") {
      return Response.json({ config: { provider: "remote", remote_url: "http://gpu.test:6789", fallback_to_cpu: true, voice: "bm_george" } });
    }
    throw new TypeError("fetch failed");
  };
  const host = createFakePluginHost({ settings: { serverUrl: "http://127.0.0.1:6789" } });
  try {
    const t0 = Date.now();
    await createPlugin({ fetch: fakeFetch, migrationPatchMs: 50 })(host.bb);
    assert.ok(Date.now() - t0 < 2_000);
    assert.deepEqual(patches, [{ provider: "cpu" }]);
    const settings = await host.bb.storage.kv.get<Settings>("settings");
    assert.deepEqual(settings?.engines, { main: { url: "http://gpu.test:6789" }, backup: "local" });
    assert.equal(settings?.voice, "bm_george");
    assert.equal(await host.bb.storage.kv.get("migration-note"), NOTE_LOCAL_SWITCH_FAILED);
  } finally {
    await host.harness.dispose();
  }
});

test("a failing settings listener does not fail the patch that was saved", async () => {
  const host = await load();
  try {
    host.bb.storage.database().exec("DROP TABLE speech_log");
    await host.harness.callRpc("patchConfig", { retention: { maxAgeDays: 7, maxEntries: 100 } });
    assert.deepEqual((await host.bb.storage.kv.get<Settings>("settings"))?.retention, { maxAgeDays: 7, maxEntries: 100 });
    const warnings = host.harness.inspection.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
    assert.ok(warnings.some((m) => /settings change/.test(m) && /speech_log/.test(m)), warnings.join("\n"));
  } finally {
    await host.harness.dispose();
  }
});

test("an engines change resets the chain, but restarts the local server only when its use changes", () => {
  const remote = (url: string) => ({ url });
  assert.deepEqual(
    enginesChange({ main: "local", backup: remote("http://a") }, { main: "local", backup: remote("http://b") }),
    { reset: true, restart: false },
    "editing a remote backup keeps the local model loaded",
  );
  assert.deepEqual(
    enginesChange({ main: remote("http://a"), backup: "local" }, { main: "local", backup: remote("http://a") }),
    { reset: true, restart: false },
    "still used locally, in another slot",
  );
  assert.deepEqual(enginesChange({ main: "local", backup: null }, { main: remote("http://a"), backup: null }), { reset: true, restart: true });
  assert.deepEqual(enginesChange({ main: remote("http://a"), backup: null }, { main: remote("http://a"), backup: "local" }), { reset: true, restart: true });
  assert.deepEqual(enginesChange({ main: "local", backup: null }, { main: "local", backup: null }), { reset: false, restart: false });
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
