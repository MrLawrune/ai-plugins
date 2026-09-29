import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpeechLogEntry } from "../schemas.ts";
import { cardState, findEntry, HISTORY_WINDOW_MS, needsPolling, normalizeSpoken, PENDING_GRACE_MS, statusText } from "./match.ts";

const entry = (o: Partial<SpeechLogEntry>): SpeechLogEntry =>
  ({ id: 1, ts: 0, session_id: "t1", text: "All done.", status: "done", ...o });

test("normalizeSpoken collapses whitespace and applies the log cap", () => {
  assert.equal(normalizeSpoken("  a \n b\t c "), "a b c");
  assert.equal(normalizeSpoken("x".repeat(2500)).length, 2000);
});

test("findEntry picks the latest matching entry in the thread", () => {
  const entries = [entry({ id: 1, status: "done" }), entry({ id: 4, status: "playing" }), entry({ id: 2, status: "error" })];
  assert.equal(findEntry(entries, "t1", "All  done.")?.id, 4);
});

test("findEntry ignores other threads", () => {
  assert.equal(findEntry([entry({ session_id: "t2" })], "t1", "All done."), undefined);
});

test("findEntry matches a say longer than the log cap", () => {
  const long = "word ".repeat(600).trim();
  assert.equal(findEntry([entry({ text: normalizeSpoken(long) })], "t1", long)?.id, 1);
});

test("cardState maps every log status", () => {
  const t = { mountedAt: 10_000, pageLoadedAt: 0, now: 10_000 };
  assert.deepEqual(cardState(entry({ status: "queued" }), t), { kind: "queued" });
  assert.deepEqual(cardState(entry({ status: "playing" }), t), { kind: "playing" });
  assert.deepEqual(cardState(entry({ status: "done", voice: "af_sky", first_audio_ms: 410 }), t),
    { kind: "spoken", voice: "af_sky", firstAudioMs: 410 });
  assert.deepEqual(cardState(entry({ status: "interrupted" }), t), { kind: "interrupted" });
  assert.deepEqual(cardState(entry({ status: "muted" }), t), { kind: "muted" });
  assert.deepEqual(cardState(entry({ status: "error", error: "engine failed" }), t), { kind: "error", detail: "engine failed" });
  assert.deepEqual(cardState(entry({ status: "error" }), t), { kind: "error", detail: "unknown error" });
  assert.deepEqual(cardState(entry({ status: "empty" }), t), { kind: "error", detail: "nothing left to speak after stripping markup" });
});

test("cardState without an entry: history, grace, then not spoken", () => {
  assert.deepEqual(cardState(undefined, { pageLoadedAt: 0, mountedAt: HISTORY_WINDOW_MS - 1, now: 60_000 }), { kind: "unknown" });
  assert.deepEqual(cardState(undefined, { pageLoadedAt: 0, mountedAt: 10_000, now: 10_000 + PENDING_GRACE_MS - 1 }), { kind: "queued" });
  assert.deepEqual(cardState(undefined, { pageLoadedAt: 0, mountedAt: 10_000, now: 10_000 + PENDING_GRACE_MS }), { kind: "unspoken" });
});

test("needsPolling only while queued or playing", () => {
  assert.equal(needsPolling({ kind: "queued" }), true);
  assert.equal(needsPolling({ kind: "playing" }), true);
  for (const kind of ["interrupted", "muted", "unspoken", "unknown"] as const) assert.equal(needsPolling({ kind }), false);
  assert.equal(needsPolling({ kind: "spoken" }), false);
});

test("statusText", () => {
  assert.equal(statusText({ kind: "spoken", voice: "af_sky", firstAudioMs: 410 }), "Spoken · af_sky · 410 ms to first audio");
  assert.equal(statusText({ kind: "spoken" }), "Spoken");
  assert.equal(statusText({ kind: "queued" }), "Queued");
  assert.equal(statusText({ kind: "playing" }), "Playing");
  assert.equal(statusText({ kind: "interrupted" }), "Interrupted");
  assert.equal(statusText({ kind: "muted" }), "Muted");
  assert.equal(statusText({ kind: "error", detail: "boom" }), "Error: boom");
  assert.equal(statusText({ kind: "unspoken" }), "Not spoken");
  assert.equal(statusText({ kind: "unknown" }), "No record");
});
