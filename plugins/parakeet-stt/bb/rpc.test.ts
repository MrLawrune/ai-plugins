import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { DictationLog } from "./dictation-log.ts";
import { PrefsStore } from "./prefs.ts";
import { createRpcHandlers } from "./rpc.ts";
import { SttError, type SttClient } from "./stt-client.ts";
import { memKv } from "./test-kv.ts";

async function setup(client: Partial<SttClient>, configured = true) {
  const kv = memKv();
  const prefs = new PrefsStore(kv);
  await prefs.load();
  await prefs.update("desktop", { customWords: ["tmux"] });
  const db = new Database(":memory:");
  const history = new DictationLog({
    db: () => db,
    migrate: (d, stmts) => { for (const sql of stmts) d.exec(sql); },
    limits: () => ({ maxEntries: prefs.get().historyMaxEntries, maxAgeDays: prefs.get().historyMaxAgeDays }),
    now: () => 1_800_000_000_000,
  });
  history.init();
  let t = 1000;
  const handlers = createRpcHandlers({ client: () => client as SttClient, configured: () => configured, prefs, history, now: () => (t += 50) });
  return { handlers, history };
}

test("transcribe decodes base64, applies prefs, records history", async () => {
  let got: { bytes: string; words: string[] } | null = null;
  const { handlers, history } = await setup({
    async transcribe(audio, _m, _f, opts) { got = { bytes: Buffer.from(audio).toString(), words: opts.customWords }; return "hello"; },
  });
  const out = await handlers.transcribe({ audioBase64: Buffer.from("abc").toString("base64"), mimeType: "audio/webm", filename: "x.webm" });
  assert.equal(out.text, "hello");
  assert.equal(out.durationMs, 50);
  assert.deepEqual(got, { bytes: "abc", words: ["tmux"] });
  assert.deepEqual(history.list().map((e) => [e.text, e.source]), [["hello", "oneshot"]]);
});

test("empty transcript is returned but not stored", async () => {
  const { handlers, history } = await setup({ async transcribe() { return ""; } });
  assert.equal((await handlers.transcribe({ audioBase64: "YQ==", mimeType: "a", filename: "b" })).text, "");
  assert.deepEqual(history.list(), []);
});

test("transcribe errors surface the server message", async () => {
  const { handlers } = await setup({ async transcribe() { throw new SttError("unauthorized", "Parakeet STT: Invalid or missing API key", 401); } });
  await assert.rejects(handlers.transcribe({ audioBase64: "YQ==", mimeType: "a", filename: "b" }), /Invalid or missing API key/);
});

test("health reports not configured without calling the server", async () => {
  const { handlers } = await setup({ async health() { throw new Error("should not be called"); } }, false);
  const h = await handlers.health();
  assert.equal(h.configured, false);
  assert.equal(h.up, false);
});

test("health reports server errors as down", async () => {
  const { handlers } = await setup({ async health() { throw new SttError("unreachable", "unreachable at x", null); } });
  const h = await handlers.health();
  assert.deepEqual([h.configured, h.up, h.error], [true, false, "unreachable at x"]);
});

test("listHistory and clearHistory read and empty the log", async () => {
  const { handlers, history } = await setup({});
  history.add({ text: "x", durationMs: 1, source: "stream", deviceId: null });
  assert.deepEqual((await handlers.listHistory()).entries.map((e) => [e.text, e.source]), [["x", "stream"]]);
  assert.deepEqual(await handlers.clearHistory(), { cleared: true });
  assert.deepEqual((await handlers.listHistory()).entries, []);
});
