import { test } from "node:test";
import assert from "node:assert/strict";
import { createAiService } from "./ai-service.ts";
import { PrefsStore } from "./prefs.ts";
import { SttError, type SttClient, type TranscribeOptions } from "./stt-client.ts";
import { memKv } from "./test-kv.ts";
import type { DictationLog } from "./dictation-log.ts";

type Added = Parameters<DictationLog["add"]>[0];

async function setup(client: Partial<SttClient>, configured = true, added: Added[] = []) {
  const prefs = new PrefsStore(memKv());
  await prefs.load();
  await prefs.update("desktop", { customWords: ["tmux"], removeFillers: false, correctionThreshold: 0.3 });
  let t = 100;
  const log = { add: (e: Added) => { added.push(e); } } as unknown as DictationLog;
  return createAiService({ client: () => client as SttClient, configured: () => configured, prefs, log, now: () => (t += 40) });
}

test("declares a transcribe-only service", async () => {
  const service = await setup({});
  assert.equal(service.id, "parakeet");
  assert.equal(typeof service.transcribe, "function");
  assert.equal("complete" in service, false);
});

test("transcribe sends the file with prefs and bb's abort signal", async () => {
  let got: { bytes: string; mimeType: string; filename: string; opts: TranscribeOptions } | null = null;
  const service = await setup({
    async transcribe(audio, mimeType, filename, opts) {
      got = { bytes: Buffer.from(audio).toString(), mimeType, filename, opts };
      return "hello";
    },
  });
  const signal = new AbortController().signal;
  const text = await service.transcribe!(new File(["abc"], "voice.webm", { type: "audio/webm" }), { signal, hint: null });
  assert.equal(text, "hello");
  assert.equal(got!.bytes, "abc");
  assert.equal(got!.mimeType, "audio/webm");
  assert.equal(got!.filename, "voice.webm");
  assert.deepEqual(got!.opts.customWords, ["tmux"]);
  assert.equal(got!.opts.removeFillers, false);
  assert.equal(got!.opts.correctionThreshold, 0.3);
  assert.equal(got!.opts.signal, signal);
});

test("transcribe rejects with the server message", async () => {
  const service = await setup({ async transcribe() { throw new SttError("unauthorized", "Parakeet STT: Invalid or missing API key", 401); } });
  await assert.rejects(
    service.transcribe!(new File(["a"], "a.webm"), { signal: new AbortController().signal, hint: null }),
    /Invalid or missing API key/,
  );
});

test("status is not ready until a server URL is set", async () => {
  assert.deepEqual(await (await setup({})).status!(), { ready: true });
  const unconfigured = await (await setup({}, false)).status!();
  assert.equal(unconfigured.ready, false);
  assert.match(unconfigured.ready ? "" : unconfigured.message, /server URL/);
});

test("a successful transcription is logged with source voice", async () => {
  const added: Added[] = [];
  const service = await setup({ async transcribe() { return "hello there"; } }, true, added);
  await service.transcribe!(new File(["a"], "a.webm"), { signal: new AbortController().signal, hint: null });
  assert.deepEqual(added, [{ text: "hello there", durationMs: 40, source: "voice", deviceId: null }]);
});

test("a failed transcription is not logged", async () => {
  const added: Added[] = [];
  const service = await setup({ async transcribe() { throw new SttError("unreachable", "down", null); } }, true, added);
  await assert.rejects(service.transcribe!(new File(["a"], "a.webm"), { signal: new AbortController().signal, hint: null }));
  assert.deepEqual(added, []);
});
