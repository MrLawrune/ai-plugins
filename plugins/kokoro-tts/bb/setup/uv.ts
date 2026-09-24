import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SetupError } from "./errors.ts";

export const UV_INSTALL_COMMAND = "curl -LsSf https://astral.sh/uv/install.sh | sh";

export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function findUv(env?: NodeJS.ProcessEnv, home?: string, exists?: (p: string) => boolean): string | null {
  return findExecutable("uv", env, home, exists);
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const keep = (d: Buffer) => { output = (output + d.toString()).slice(-4000); };
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, signal: opts.signal, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => resolve({ code: -1, output: `${output}${String(e)}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

export function installUv(signal?: AbortSignal): Promise<{ code: number; output: string }> {
  // Don't edit the user's shell profiles: findUv() already looks in ~/.local/bin.
  return run("sh", ["-c", UV_INSTALL_COMMAND], { signal, env: { ...process.env, UV_NO_MODIFY_PATH: "1" } });
}

export async function syncRuntime(uv: string, serverDir: string, runtime: "cpu" | "gpu", venv: string, signal?: AbortSignal): Promise<void> {
  const args = ["sync", "--project", serverDir, "--group", runtime, "--no-default-groups", "--frozen"];
  const r = await run(uv, args, { env: { ...process.env, UV_PROJECT_ENVIRONMENT: venv }, signal });
  if (signal?.aborted) return;
  if (r.code !== 0) {
    const last = r.output.trim().split("\n").at(-1) ?? "unknown error";
    throw new SetupError(`Runtime install failed: ${last}`, `UV_PROJECT_ENVIRONMENT="${venv}" ${uv} ${args.join(" ")}`);
  }
}

export async function probeAudio(python: string, signal?: AbortSignal): Promise<boolean> {
  const r = await run(python, ["-c", "import sounddevice as sd; sd.query_devices(kind='output')"], { signal });
  return r.code === 0;
}
