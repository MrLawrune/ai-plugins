import { test } from "node:test";
import assert from "node:assert/strict";
import { createAiService, hintWords } from "./ai-service.ts";
import { LoadScope } from "./lifecycle.ts";
import { PrefsStore } from "./prefs.ts";
import { SttError, type SttClient, type TranscribeOptions } from "./stt-client.ts";
import { memKv } from "./test-kv.ts";
import type { DictationLog } from "./dictation-log.ts";

type Added = Parameters<DictationLog["add"]>[0];

async function setup(client: Partial<SttClient>, configured = true, added: Added[] = [], scope = new LoadScope(), latency: { ms: number | null } = { ms: null }) {
  const prefs = new PrefsStore(memKv());
  await prefs.load();
  await prefs.update("desktop", { customWords: ["tmux"], removeFillers: false, correctionThreshold: 0.3 });
  let t = 100;
  const log = { add: (e: Added) => { added.push(e); } } as unknown as DictationLog;
  return createAiService({ client: () => client as SttClient, configured: () => configured, prefs, log, now: () => (t += 40), scope, latency });
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
  const ctl = new AbortController();
  const signal = ctl.signal;
  const text = await service.transcribe!(new File(["abc"], "voice.webm", { type: "audio/webm" }), { signal, hint: null });
  assert.equal(text, "hello");
  assert.equal(got!.bytes, "abc");
  assert.equal(got!.mimeType, "audio/webm");
  assert.equal(got!.filename, "voice.webm");
  assert.deepEqual(got!.opts.customWords, ["tmux"]);
  assert.equal(got!.opts.removeFillers, false);
  assert.equal(got!.opts.correctionThreshold, 0.3);
  assert.equal(got!.opts.signal!.aborted, false);
  ctl.abort();
  assert.equal(got!.opts.signal!.aborted, true, "bb's request signal reaches the client");
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

test("hintWords splits on commas and newlines, trims, drops empties and over-long entries", () => {
  assert.deepEqual(hintWords("tmux, kubectl\nPodman"), ["tmux", "kubectl", "Podman"]);
  assert.deepEqual(hintWords(" , ,\n\n"), []);
  assert.deepEqual(hintWords(null), []);
  assert.deepEqual(hintWords(undefined), []);
  assert.deepEqual(hintWords(`ok,${"x".repeat(65)},${"y".repeat(64)}`), ["ok", "y".repeat(64)]);
});

test("transcribe sends the union of the prefs words and the hint, deduped and capped at 200", async () => {
  let words: string[] = [];
  const service = await setup({ async transcribe(_a, _m, _f, opts) { words = opts.customWords; return "x"; } });
  const signal = new AbortController().signal;
  await service.transcribe!(new File(["a"], "a.webm"), { signal, hint: "kubectl, tmux\nPodman" });
  assert.deepEqual(words, ["tmux", "kubectl", "Podman"]);
  const many = Array.from({ length: 300 }, (_, i) => `w${i}`).join(",");
  await service.transcribe!(new File(["a"], "a.webm"), { signal, hint: many });
  assert.equal(words.length, 200);
  assert.equal(words[0], "tmux");
});

const file = new File(["a"], "a.webm");
const never = (signal: AbortSignal) => new Promise<string>((_r, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));

test("the plugin's load scope cancels a voice transcription, which disposal waits for", async () => {
  const scope = new LoadScope();
  const added: Added[] = [];
  let seen: AbortSignal | null = null;
  const service = await setup({ async transcribe(_a, _m, _f, opts) { seen = opts.signal!; return never(seen); } }, true, added, scope);
  const pending = service.transcribe!(file, { signal: new AbortController().signal, hint: null });
  const settled = pending.then(() => "ok", () => "rejected");
  await new Promise((r) => setTimeout(r, 5));
  await scope.dispose();
  assert.equal(seen!.aborted, true);
  assert.equal(await settled, "rejected");
  assert.deepEqual(added, []);
});

test("a transcription that finishes after disposal writes no history; one stuck in arrayBuffer never reaches the server", async () => {
  const scope = new LoadScope();
  const added: Added[] = [];
  let calls = 0;
  const service = await setup({ async transcribe() { calls++; scope.abort(); return "late"; } }, true, added, scope);
  await assert.rejects(service.transcribe!(file, { signal: new AbortController().signal, hint: null }));
  assert.deepEqual(added, [], "no history write once the plugin is stopping");

  const scope2 = new LoadScope();
  const service2 = await setup({ async transcribe() { calls++; return "x"; } }, true, added, scope2);
  let release!: () => void;
  const slow = { type: "audio/webm", name: "s.webm", arrayBuffer: () => new Promise<ArrayBuffer>((r) => { release = () => r(new ArrayBuffer(1)); }) } as unknown as File;
  const pending = service2.transcribe!(slow, { signal: new AbortController().signal, hint: null });
  const settled = pending.then(() => "ok", () => "rejected");
  scope2.abort();
  release();
  assert.equal(await settled, "rejected");
  assert.equal(calls, 1, "the stuck one never called the client");
});

test("voice transcriptions feed the shared latency reading", async () => {
  const latency = { ms: null as number | null };
  const service = await setup({ async transcribe() { return "hi"; } }, true, [], new LoadScope(), latency);
  await service.transcribe!(file, { signal: new AbortController().signal, hint: null });
  assert.equal(latency.ms, 40);
});
