import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ensureModels, type ModelFile } from "./models.ts";

const BODY = Buffer.from("kokoro-model-bytes-".repeat(500));
const SHA = createHash("sha256").update(BODY).digest("hex");

async function serve(opts: { honorRange: boolean }) {
  const requests: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers.range);
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (m && opts.honorRange) {
      const start = Number(m[1]);
      res.writeHead(206, { "content-length": BODY.length - start });
      res.end(BODY.subarray(start));
    } else {
      res.writeHead(200, { "content-length": BODY.length });
      res.end(BODY);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/m.bin`, requests, close: () => server.close() };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-models-"));
const file = (url: string, sha = SHA): ModelFile => ({ name: "m.bin", url, size: BODY.length, sha256: sha });

test("fresh download verifies and writes a marker", async () => {
  const srv = await serve({ honorRange: true });
  const dir = tmp();
  const progress: number[] = [];
  await ensureModels(dir, [file(srv.url)], { onProgress: (f) => progress.push(f) });
  srv.close();
  assert.ok(fs.readFileSync(path.join(dir, "m.bin")).equals(BODY));
  assert.equal(fs.readFileSync(path.join(dir, "m.bin.sha256"), "utf8"), SHA);
  assert.equal(progress.at(-1), 1);
});

test("resumes a partial download with Range", async () => {
  const srv = await serve({ honorRange: true });
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "m.bin.part"), BODY.subarray(0, 1000));
  await ensureModels(dir, [file(srv.url)]);
  srv.close();
  assert.deepEqual(srv.requests, ["bytes=1000-"]);
  assert.ok(fs.readFileSync(path.join(dir, "m.bin")).equals(BODY));
});

test("server ignoring Range restarts the file", async () => {
  const srv = await serve({ honorRange: false });
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "m.bin.part"), BODY.subarray(0, 1000));
  await ensureModels(dir, [file(srv.url)]);
  srv.close();
  assert.ok(fs.readFileSync(path.join(dir, "m.bin")).equals(BODY));
});

test("checksum mismatch discards the download", async () => {
  const srv = await serve({ honorRange: true });
  const dir = tmp();
  await assert.rejects(ensureModels(dir, [file(srv.url, "0".repeat(64))]), /Checksum mismatch/);
  srv.close();
  assert.equal(fs.existsSync(path.join(dir, "m.bin.part")), false);
  assert.equal(fs.existsSync(path.join(dir, "m.bin")), false);
});

test("verified file with marker is not fetched again", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "m.bin"), BODY);
  fs.writeFileSync(path.join(dir, "m.bin.sha256"), SHA);
  let fetched = false;
  const fetchImpl = (async () => { fetched = true; return new Response(""); }) as typeof fetch;
  await ensureModels(dir, [file("http://unused")], { fetchImpl });
  assert.equal(fetched, false);
});

test("existing file without marker is hashed once and adopted", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "m.bin"), BODY);
  const fetchImpl = (async () => { throw new Error("should not fetch"); }) as typeof fetch;
  await ensureModels(dir, [file("http://unused")], { fetchImpl });
  assert.equal(fs.readFileSync(path.join(dir, "m.bin.sha256"), "utf8"), SHA);
});
