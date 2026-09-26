import fs from "node:fs";
import path from "node:path";

/**
 * Tell the Claude Code hooks on this machine that the bb plugin runs the server
 * and supplies the voice contract, so they stand down inside bb threads.
 * Returns a cleanup that removes the file only if it is still ours.
 */
export function writePresence(dir: string, pid: number = process.pid): () => void {
  const file = path.join(dir, "bb-plugin.pid");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, String(pid));
  return () => {
    try {
      if (fs.readFileSync(file, "utf8").trim() === String(pid)) fs.rmSync(file);
    } catch {
      // already gone
    }
  };
}
