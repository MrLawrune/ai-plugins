import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS } from "./prefs.ts";
import { parseServerEvent, streamOptionsFrom, upstreamUrl } from "./stream-protocol.ts";

test("parses known events and rejects junk", () => {
  assert.deepEqual(parseServerEvent('{"type":"partial","seq":2,"text":"hi"}'), { type: "partial", seq: 2, text: "hi" });
  assert.deepEqual(parseServerEvent('{"type":"ended","reason":"silence"}'), { type: "ended", reason: "silence" });
  assert.equal(parseServerEvent("nope"), null);
  assert.equal(parseServerEvent('{"type":"ended","reason":"bored"}'), null);
  assert.equal(parseServerEvent(new Uint8Array([1])), null);
});

test("options follow prefs", () => {
  assert.deepEqual(streamOptionsFrom({ ...DEFAULT_PREFS, customWords: ["tmux"] }), {
    pause_ms: 600, silence_timeout_s: null, commands: null, preview: true,
    custom_words: ["tmux"], remove_fillers: true, correction_threshold: 0.18,
  });
  const o = streamOptionsFrom({ ...DEFAULT_PREFS, endOnSilence: true, voiceCommands: true, livePreview: false });
  assert.equal(o.silence_timeout_s, 8);
  assert.deepEqual(o.commands, { send: "send it", stop: "stop listening" });
  assert.equal(o.preview, false);
});

test("upstream url", () => {
  assert.equal(upstreamUrl("https://stt.example.com/"), "wss://stt.example.com/v1/stream");
  assert.equal(upstreamUrl("http://127.0.0.1:6790"), "ws://127.0.0.1:6790/v1/stream");
});
