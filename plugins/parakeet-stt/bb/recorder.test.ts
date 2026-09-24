import { test } from "node:test";
import assert from "node:assert/strict";
import { blobToBase64, extensionFor, pickMimeType } from "./recorder.ts";

test("prefers opus webm, falls back to mp4 (iOS Safari)", () => {
  assert.equal(pickMimeType(() => true), "audio/webm;codecs=opus");
  assert.equal(pickMimeType((t) => t === "audio/mp4"), "audio/mp4");
  assert.equal(pickMimeType(() => false), null);
});

test("extensions", () => {
  assert.equal(extensionFor("audio/webm;codecs=opus"), "webm");
  assert.equal(extensionFor("audio/ogg;codecs=opus"), "ogg");
  assert.equal(extensionFor("audio/mp4"), "m4a");
  assert.equal(extensionFor(""), "webm");
});

test("blobToBase64", async () => {
  assert.equal(await blobToBase64(new Blob(["abc"])), "YWJj");
});
