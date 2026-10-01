import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../schemas.ts";
import {
  migrate,
  oldConfigPath,
  NOTE_LOCAL_SWITCH_FAILED,
  NOTE_SERVER_PLAYBACK,
  NOTE_UNREADABLE,
  type MigrateDeps,
} from "./migrate.ts";

const LOCAL = "http://127.0.0.1:6789";

function deps(over: Partial<MigrateDeps> = {}): MigrateDeps & { providers: string[] } {
  const providers: string[] = [];
  return {
    serverUrl: LOCAL,
    rawPrefs: undefined,
    runtime: "cpu",
    fetchConfig: async () => null,
    readFile: () => null,
    env: {},
    home: "/home/u",
    setLocalProvider: async (p) => { providers.push(p); },
    ...over,
    providers,
  };
}

test("local cpu config maps to main local", async () => {
  const d = deps({ fetchConfig: async () => ({ provider: "cpu", voice: "bm_george" }) });
  const r = await migrate(d);
  assert.deepEqual(r.settings.engines, { main: "local", backup: null });
  assert.equal(r.settings.voice, "bm_george");
  assert.equal(r.note, null);
  assert.deepEqual(d.providers, []);
});

test("remote with fallback maps to main url, backup local, and switches the local server to cpu", async () => {
  const d = deps({ fetchConfig: async () => ({ provider: "remote", remote_url: "http://gpu.example:6789", fallback_to_cpu: true }) });
  const r = await migrate(d);
  assert.deepEqual(r.settings.engines, { main: { url: "http://gpu.example:6789" }, backup: "local" });
  assert.deepEqual(d.providers, ["cpu"]);
  assert.equal(r.note, null);
});

test("remote with fallback on a gpu runtime switches the local server to cuda", async () => {
  const d = deps({ runtime: "gpu", fetchConfig: async () => ({ provider: "remote", remote_url: "http://gpu.example:6789" }) });
  const r = await migrate(d);
  assert.equal(r.settings.engines.backup, "local");
  assert.deepEqual(d.providers, ["cuda"]);
});

test("remote without fallback has no backup and makes no provider call", async () => {
  const d = deps({ fetchConfig: async () => ({ provider: "remote", remote_url: "http://gpu.example:6789", fallback_to_cpu: false }) });
  const r = await migrate(d);
  assert.deepEqual(r.settings.engines, { main: { url: "http://gpu.example:6789" }, backup: null });
  assert.deepEqual(d.providers, []);
});

test("non-loopback serverUrl becomes the main engine", async () => {
  const d = deps({ serverUrl: "http://tts.example:6789/", fetchConfig: async () => ({ provider: "remote", remote_url: "http://other.example" }) });
  const r = await migrate(d);
  assert.deepEqual(r.settings.engines, { main: { url: "http://tts.example:6789" }, backup: null });
  assert.deepEqual(d.providers, []);
});

test("server unreachable reads the XDG config file", async () => {
  const reads: string[] = [];
  const d = deps({
    env: { XDG_CONFIG_HOME: "/xdg" },
    readFile: (p) => { reads.push(p); return p === "/xdg/kokoro-tts/config.json" ? JSON.stringify({ voice: "am_adam", mode: "quiet" }) : null; },
  });
  const r = await migrate(d);
  assert.deepEqual(reads, ["/xdg/kokoro-tts/config.json"]);
  assert.equal(r.settings.voice, "am_adam");
  assert.equal(r.settings.mode, "quiet");
  assert.equal(r.note, null);
});

test("server unreachable on a non-loopback url does not read the file", async () => {
  const reads: string[] = [];
  const r = await migrate(deps({ serverUrl: "http://tts.example:6789", readFile: (p) => { reads.push(p); return "{}"; } }));
  assert.deepEqual(reads, []);
  assert.equal(r.note, NOTE_UNREADABLE);
});

test("KOKORO_CONFIG wins over XDG_CONFIG_HOME", () => {
  assert.equal(oldConfigPath({ KOKORO_CONFIG: "/k.json", XDG_CONFIG_HOME: "/xdg" }, "/home/u"), "/k.json");
  assert.equal(oldConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u"), "/xdg/kokoro-tts/config.json");
  assert.equal(oldConfigPath({}, "/home/u"), "/home/u/.config/kokoro-tts/config.json");
});

test("migrate reads the KOKORO_CONFIG file", async () => {
  const d = deps({
    env: { KOKORO_CONFIG: "/k.json", XDG_CONFIG_HOME: "/xdg" },
    readFile: (p) => (p === "/k.json" ? JSON.stringify({ voice: "bf_emma" }) : JSON.stringify({ voice: "am_adam" })),
  });
  assert.equal((await migrate(d)).settings.voice, "bf_emma");
});

test("server and file both missing gives defaults and the unreadable note", async () => {
  const r = await migrate(deps());
  assert.deepEqual(r.settings, DEFAULT_SETTINGS);
  assert.equal(r.note, NOTE_UNREADABLE);
});

test("an unparseable config file gives defaults and the unreadable note", async () => {
  const r = await migrate(deps({ readFile: () => "{not json" }));
  assert.deepEqual(r.settings, DEFAULT_SETTINGS);
  assert.equal(r.note, NOTE_UNREADABLE);
});

test("invalid speed falls back to default while other fields are kept", async () => {
  const r = await migrate(deps({ fetchConfig: async () => ({ speed: 9, voice: "bm_george", gap_ms: 120 }) }));
  assert.equal(r.settings.speed, DEFAULT_SETTINGS.speed);
  assert.equal(r.settings.voice, "bm_george");
  assert.equal(r.settings.gap_ms, 120);
  assert.equal(r.settings.v, 1);
});

test("server playback note", async () => {
  const r = await migrate(deps({ rawPrefs: { playback: "server" }, fetchConfig: async () => ({}) }));
  assert.equal(r.note, NOTE_SERVER_PLAYBACK);
  const both = await migrate(deps({ rawPrefs: { playback: "server" } }));
  assert.ok(both.note!.includes(NOTE_SERVER_PLAYBACK));
  assert.ok(both.note!.includes(NOTE_UNREADABLE));
});

test("a failed local provider switch adds a note and still returns settings", async () => {
  const d = deps({
    fetchConfig: async () => ({ provider: "remote", remote_url: "http://gpu.example:6789", voice: "bm_george" }),
    setLocalProvider: async () => { throw new Error("boom"); },
  });
  const r = await migrate(d);
  assert.ok(r.note!.includes(NOTE_LOCAL_SWITCH_FAILED));
  assert.deepEqual(r.settings.engines, { main: { url: "http://gpu.example:6789" }, backup: "local" });
  assert.equal(r.settings.voice, "bm_george");
});

test("a remote_url the settings schema rejects falls back to main local", async () => {
  const d = deps({ fetchConfig: async () => ({ provider: "remote", remote_url: "not a url" }) });
  const r = await migrate(d);
  assert.deepEqual(r.settings.engines, { main: "local", backup: null });
  assert.deepEqual(d.providers, []);
});

test("custom loopback port maps to main local", async () => {
  const r = await migrate(deps({ serverUrl: "http://127.0.0.1:7000", fetchConfig: async () => ({ provider: "cpu" }) }));
  assert.deepEqual(r.settings.engines, { main: "local", backup: null });
});

test("unexpected errors yield defaults and the unreadable note", async () => {
  const r = await migrate(deps({ fetchConfig: async () => { throw new Error("boom"); } }));
  assert.deepEqual(r.settings, DEFAULT_SETTINGS);
  assert.equal(r.note, NOTE_UNREADABLE);
});
