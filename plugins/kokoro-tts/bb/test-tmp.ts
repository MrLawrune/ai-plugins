// Temp dirs for tests, removed when the test process exits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const made: string[] = [];
let hooked = false;

export function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const d of made) fs.rmSync(d, { recursive: true, force: true });
    });
  }
  return dir;
}
