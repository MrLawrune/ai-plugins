import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFrame, encodeFrame, parseClientMsg } from "./protocol.ts";

test("frame round trip", () => {
  const pcm = new Uint8Array(new Float32Array([0.1, -0.2, 0.3]).buffer);
  const { entryId, pcm: out } = decodeFrame(encodeFrame(42, pcm));
  assert.equal(entryId, 42);
  assert.deepEqual([...out].map((v) => v.toFixed(2)), ["0.10", "-0.20", "0.30"]);
});

test("parseClientMsg accepts valid messages", () => {
  assert.deepEqual(parseClientMsg('{"type":"focus","focusedAt":5}'), { type: "focus", focusedAt: 5 });
  assert.equal(parseClientMsg('{"type":"status","entryId":3,"status":"playing","firstAudioMs":400}')?.type, "status");
});

test("parseClientMsg rejects junk", () => {
  assert.equal(parseClientMsg("not json"), null);
  assert.equal(parseClientMsg('{"type":"status","entryId":3,"status":"exploded"}'), null);
  assert.equal(parseClientMsg('{"type":"hello","clientId":"","deviceName":"x","focusedAt":0,"audioUnlocked":true}'), null);
});
