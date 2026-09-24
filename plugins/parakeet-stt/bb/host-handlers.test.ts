import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleTranscribe, readHostConfig, writeHostConfig } from "./host-handlers.ts";

const config = { serverUrl: "https://stt.example", apiKey: "k", customWords: ["tmux"], removeFillers: true, correctionThreshold: 0.18 };
const input = { serviceId: "parakeet", model: "parakeet-tdt-0.6b-v2", audioBase64: Buffer.from("abc").toString("base64"), mimeType: "audio/webm", filename: "voice.webm", prompt: null, timeoutMs: 10_000 };
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "stt-host-"));

test("config round-trips with 0600 permissions", async () => {
  const dir = await tmp();
  await writeHostConfig(path.join(dir, "nested"), config);
  assert.deepEqual(await readHostConfig(path.join(dir, "nested")), config);
  const st = await fs.stat(path.join(dir, "nested", "config.json"));
  assert.equal(st.mode & 0o777, 0o600);
});

test("missing or corrupt config reads as null", async () => {
  const dir = await tmp();
  assert.equal(await readHostConfig(dir), null);
  await fs.writeFile(path.join(dir, "config.json"), "{nope");
  assert.equal(await readHostConfig(dir), null);
});

test("transcribe without config -> auth_required", async () => {
  const out = await handleTranscribe(input, await tmp());
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.code, "auth_required");
});

test("transcribe forwards decoded audio and prefs", async () => {
  const dir = await tmp();
  await writeHostConfig(dir, config);
  let seen: FormData | null = null;
  const f = (async (_u: string, init?: RequestInit) => { seen = init!.body as FormData; return Response.json({ text: "hi" }); }) as typeof fetch;
  const out = await handleTranscribe(input, dir, f);
  assert.deepEqual(out, { ok: true, model: "parakeet-tdt-0.6b-v2", text: "hi" });
  const file = seen!.get("file") as File;
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "abc");
  assert.equal(seen!.get("custom_words"), '["tmux"]');
});

test("server 503 -> service_unavailable (retryable)", async () => {
  const dir = await tmp();
  await writeHostConfig(dir, config);
  const f = (async () => Response.json({ error: { message: "loading" } }, { status: 503 })) as typeof fetch;
  const out = await handleTranscribe(input, dir, f);
  assert.equal(!out.ok && out.code, "service_unavailable");
});

test("timeout budget leaves headroom under bb's timeoutMs", async () => {
  const dir = await tmp();
  await writeHostConfig(dir, config);
  const f = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
  const started = Date.now();
  const out = await handleTranscribe({ ...input, timeoutMs: 600 }, dir, f);
  assert.equal(!out.ok && out.code, "timeout");
  assert.ok(Date.now() - started < 600);
});
