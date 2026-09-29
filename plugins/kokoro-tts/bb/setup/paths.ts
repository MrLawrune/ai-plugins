import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "kokoro-tts");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "kokoro-tts");
}

export function venvDir(runtime: "cpu" | "gpu", base = dataDir()): string {
  return path.join(base, `venv-${runtime}`);
}

export function pythonIn(venv: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

/** The plugin root is the first ancestor holding server/kokoro_server.py. */
export function locatePluginRoot(startDir: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  let dir = startDir;
  for (let i = 0; i < 4; i++) {
    if (exists(path.join(dir, "server", "kokoro_server.py"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
