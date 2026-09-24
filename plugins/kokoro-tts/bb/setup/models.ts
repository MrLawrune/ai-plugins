import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { SetupError } from "./errors.ts";

export interface ModelFile {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

export function loadModelManifest(serverDir: string): ModelFile[] {
  return (JSON.parse(fs.readFileSync(path.join(serverDir, "models.json"), "utf8")) as { files: ModelFile[] }).files;
}

export async function sha256File(p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(p)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function verified(target: string, f: ModelFile): Promise<boolean> {
  try {
    if (fs.statSync(target).size !== f.size) return false;
  } catch {
    return false;
  }
  try {
    if (fs.readFileSync(`${target}.sha256`, "utf8").trim() === f.sha256) return true;
  } catch {
    // no marker yet
  }
  if ((await sha256File(target)) !== f.sha256) return false;
  fs.writeFileSync(`${target}.sha256`, f.sha256);
  return true;
}

export async function ensureModels(
  dir: string,
  files: ModelFile[],
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  fs.mkdirSync(dir, { recursive: true });
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const report = (inFlight: number) => opts.onProgress?.(total ? Math.min(1, (done + inFlight) / total) : 1);
  for (const f of files) {
    const target = path.join(dir, f.name);
    if (!(await verified(target, f))) await download(f, target, fetchImpl, opts.signal, report);
    done += f.size;
    report(0);
  }
}

async function download(
  f: ModelFile,
  target: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  onBytes: (written: number) => void,
): Promise<void> {
  const part = `${target}.part`;
  const fix = `curl -L -o "${target}" ${f.url}`;
  let start = 0;
  try {
    start = fs.statSync(part).size;
  } catch {
    // no partial file
  }
  if (start > f.size) {
    fs.rmSync(part, { force: true });
    start = 0;
  }
  if (start < f.size) {
    const res = await fetchImpl(f.url, { headers: start > 0 ? { Range: `bytes=${start}-` } : {}, signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new SetupError(`Download failed for ${f.name}: HTTP ${res.status}`, fix);
    const append = start > 0 && res.status === 206;
    let written = append ? start : 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        onBytes(written);
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeWebStream<Uint8Array>),
      counter,
      fs.createWriteStream(part, { flags: append ? "a" : "w" }),
      { signal },
    );
  }
  if ((await sha256File(part)) !== f.sha256) {
    fs.rmSync(part, { force: true });
    throw new SetupError(`Checksum mismatch for ${f.name}; the download was discarded`, fix);
  }
  fs.renameSync(part, target);
  fs.writeFileSync(`${target}.sha256`, f.sha256);
}
