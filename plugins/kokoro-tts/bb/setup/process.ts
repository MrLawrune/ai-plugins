import { spawn } from "node:child_process";
import readline from "node:readline";
import type { ServerProcess } from "../supervisor.ts";

export function spawnServer(o: {
  python: string;
  serverDir: string;
  modelPath: string;
  voicesPath: string;
  port: number;
  headless: boolean;
  log: (line: string) => void;
}): ServerProcess {
  const child = spawn(o.python, ["kokoro_server.py"], {
    cwd: o.serverDir,
    env: {
      ...process.env,
      KOKORO_MODEL: o.modelPath,
      KOKORO_VOICES: o.voicesPath,
      KOKORO_PORT: String(o.port),
      ...(o.headless ? { KOKORO_HEADLESS: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", o.log);
  }
  const exited = new Promise<number | string | null>((resolve) => {
    child.on("exit", (code, signal) => resolve(signal ? `signal ${signal}` : code));
    child.on("error", (err) => resolve(err.message));
  });
  return {
    exited,
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    },
  };
}
