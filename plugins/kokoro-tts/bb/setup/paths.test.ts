import { test } from "node:test";
import assert from "node:assert/strict";
import { dataDir, locatePluginRoot, pythonIn, venvDir } from "./paths.ts";

test("dataDir follows XDG, then ~/.local/share, then macOS", () => {
  assert.equal(dataDir({ XDG_DATA_HOME: "/x" }, "linux", "/h/u"), "/x/kokoro-tts");
  assert.equal(dataDir({}, "linux", "/h/u"), "/h/u/.local/share/kokoro-tts");
  assert.equal(dataDir({}, "darwin", "/Users/u"), "/Users/u/Library/Application Support/kokoro-tts");
});

test("venv and python paths", () => {
  assert.equal(venvDir("gpu", "/d"), "/d/venv-gpu");
  assert.equal(pythonIn("/d/venv-cpu", "linux"), "/d/venv-cpu/bin/python");
});

test("locatePluginRoot walks up from dist/", () => {
  const exists = (p: string) => p === "/p/kokoro-tts/server/kokoro_server.py";
  assert.equal(locatePluginRoot("/p/kokoro-tts/dist", exists), "/p/kokoro-tts");
  assert.equal(locatePluginRoot("/elsewhere/dist", exists), null);
});

