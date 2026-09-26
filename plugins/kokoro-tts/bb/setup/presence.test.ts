import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePresence } from "./presence.ts";

test("writes this process's pid and removes only its own file", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-presence-")), "kokoro-tts");
  const clear = writePresence(dir, 4242);
  const file = path.join(dir, "bb-plugin.pid");
  assert.equal(fs.readFileSync(file, "utf8"), "4242");
  fs.writeFileSync(file, "999"); // a newer plugin load took over
  clear();
  assert.equal(fs.readFileSync(file, "utf8"), "999");
  writePresence(dir, 4242)();
  assert.equal(fs.existsSync(file), false);
});
