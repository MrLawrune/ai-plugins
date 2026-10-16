import { test } from "node:test";
import assert from "node:assert/strict";
import { blobToBase64, extensionFor, pickMimeType, startBrowserRecording, type RecorderEnv } from "./recorder.ts";

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

function fakeTrack() {
  return { stops: 0, onended: null as (() => void) | null, stop() { this.stops++; } };
}

function recorderEnv(over: { MediaRecorder?: unknown; getUserMedia?: () => Promise<unknown> } = {}) {
  const track = fakeTrack();
  const other = fakeTrack();
  const doc = {
    visibilityState: "visible",
    listeners: 0,
    addEventListener() { this.listeners++; },
    removeEventListener() { this.listeners--; },
  };
  class OkRecorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm;codecs=opus";
    ondataavailable: unknown = null;
    onstop: unknown = null;
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  }
  const stream = { getTracks: () => [track, other], getAudioTracks: () => [track] };
  const env = {
    getUserMedia: over.getUserMedia ?? (async () => stream),
    MediaRecorder: over.MediaRecorder ?? OkRecorder,
    doc,
  } as unknown as RecorderEnv;
  return { env, tracks: [track, other], doc, OkRecorder };
}

test("a MediaRecorder that cannot be constructed still releases every track and rethrows", async () => {
  class Boom { static isTypeSupported() { return true; } constructor() { throw new Error("recorder refused"); } }
  const { env, tracks, doc } = recorderEnv({ MediaRecorder: Boom });
  await assert.rejects(startBrowserRecording(() => {}, () => true, env), /recorder refused/);
  assert.deepEqual(tracks.map((t) => t.stops), [1, 1]);
  assert.equal(doc.listeners, 0);
});

test("recorder.start() throwing after the capture guard is armed unguards, stops tracks, clears the limit timer", async () => {
  const base = recorderEnv();
  class StartBoom extends base.OkRecorder { start(): void { throw new Error("start refused"); } }
  const { env, tracks, doc } = recorderEnv({ MediaRecorder: StartBoom });
  const cleared: unknown[] = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const ids: unknown[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { const id = realSet(fn, ms); ids.push(id); return id; }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => { cleared.push(id); realClear(id); }) as typeof clearTimeout;
  try {
    await assert.rejects(startBrowserRecording(() => {}, () => true, env), /start refused/);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  assert.deepEqual(tracks.map((t) => t.stops), [1, 1]);
  assert.equal(doc.listeners, 0);
  assert.equal(tracks[0].onended, null);
  assert.equal(ids.length, 1);
  assert.deepEqual(cleared, ids); // the 5-minute limit timer is cleared, not leaked
});

test("a recorder that starts is left running until stop or cancel", async () => {
  const { env, tracks, doc } = recorderEnv();
  const handle = await startBrowserRecording(() => {}, () => true, env);
  assert.deepEqual(tracks.map((t) => t.stops), [0, 0]);
  assert.equal(doc.listeners, 1);
  handle.cancel();
  assert.deepEqual(tracks.map((t) => t.stops), [1, 1]);
  assert.equal(doc.listeners, 0);
});
