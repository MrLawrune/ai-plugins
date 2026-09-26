import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePresence } from "./presence.ts";

test("writes this process's pid first and removes only its own file", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-presence-")), "kokoro-tts");
  const clear = writePresence(dir, 4242);
  const file = path.join(dir, "bb-plugin.pid");
  assert.match(fs.readFileSync(file, "utf8"), /^4242 \S+$/);
  fs.writeFileSync(file, "999 other"); // a newer plugin load took over
  clear();
  assert.equal(fs.readFileSync(file, "utf8"), "999 other");
  writePresence(dir, 4242)();
  assert.equal(fs.existsSync(file), false);
});

test("a reload in the same pid leaves the newer instance's file alone", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-presence-")), "kokoro-tts");
  const clearOld = writePresence(dir, 4242);
  const clearNew = writePresence(dir, 4242);
  clearOld();
  assert.equal(fs.existsSync(path.join(dir, "bb-plugin.pid")), true);
  clearNew();
  assert.equal(fs.existsSync(path.join(dir, "bb-plugin.pid")), false);
});
