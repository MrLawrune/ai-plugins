import { test } from "node:test";
import assert from "node:assert/strict";
import { guardCapture } from "./capture-guard.ts";

function fakeDoc() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: "visible",
    addEventListener: (_t: "visibilitychange", f: () => void) => listeners.add(f),
    removeEventListener: (_t: "visibilitychange", f: () => void) => listeners.delete(f),
    hide() { this.visibilityState = "hidden"; for (const l of listeners) l(); },
    count: () => listeners.size,
  };
}

function fakeTrack() {
  return { onended: null as (() => void) | null, end() { this.onended?.(); } };
}

test("screen off keeps listening when the pref is on", () => {
  const doc = fakeDoc(); const track = fakeTrack(); const seen: string[] = [];
  guardCapture({ doc, tracks: [track], keepListeningHidden: () => true, onInterrupt: (w) => seen.push(w) });
  doc.hide();
  assert.deepEqual(seen, []);
});

test("screen off stops when the pref is off", () => {
  const doc = fakeDoc(); const seen: string[] = [];
  guardCapture({ doc, tracks: [], keepListeningHidden: () => false, onInterrupt: (w) => seen.push(w) });
  doc.hide();
  assert.deepEqual(seen, ["hidden"]);
});

test("browser ending the mic track interrupts as lost", () => {
  const doc = fakeDoc(); const track = fakeTrack(); const seen: string[] = [];
  guardCapture({ doc, tracks: [track], keepListeningHidden: () => true, onInterrupt: (w) => seen.push(w) });
  track.end();
  assert.deepEqual(seen, ["lost"]);
});

test("release removes the listeners", () => {
  const doc = fakeDoc(); const track = fakeTrack(); const seen: string[] = [];
  const release = guardCapture({ doc, tracks: [track], keepListeningHidden: () => false, onInterrupt: (w) => seen.push(w) });
  release();
  doc.hide(); track.end();
  assert.deepEqual(seen, []);
  assert.equal(doc.count(), 0);
});
