import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyCuePrefs, capSpeech, extractDirective, firstSentence, FULL_MAX_CHARS, fullText, route, routeCue, routeTurn } from "./turn.ts";
import type { Mode } from "../schemas.ts";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/turn.json", import.meta.url), "utf8"));

const REST = "\n\nThe rest is on screen.";
const len = (s: string) => Array.from(s).length;
/**
 * Python cuts a long full-mode reply at FULL_MAX_CHARS and then adds the
 * suffix (over 6000 in all); the plugin cuts earlier so the suffix fits. Its
 * text is then the same reply cut at the same kind of boundary, no later.
 */
function sameCutWithinCap(ts: string, py: string, label: string) {
  assert.ok(len(ts) <= FULL_MAX_CHARS, `${label}: ${len(ts)} code points`);
  assert.ok(ts.endsWith(REST) && py.endsWith(REST), label);
  assert.ok(py.startsWith(ts.slice(0, -REST.length)), label);
}

test("route matches Python for every fixture", () => {
  for (const c of fx.route) {
    const label = JSON.stringify(c.text).slice(0, 80) + " " + c.mode;
    const out = route(c.text, c.mode as Mode, c.cfg);
    if (c.out.text && len(c.out.text) > FULL_MAX_CHARS) sameCutWithinCap((out as { text: string }).text, c.out.text, label);
    else assert.deepEqual(out, c.out, label);
  }
});
test("routeCue matches Python", () => {
  for (const c of fx.cue) assert.deepEqual(routeCue(c.sound, c.mode as Mode, c.cfg), c.out);
});
test("extractDirective matches Python", () => {
  for (const c of fx.directive) assert.deepEqual(extractDirective(c.text), c.out, c.text.slice(0, 80));
});
test("firstSentence matches Python", () => {
  for (const c of fx.first) assert.equal(firstSentence(c.text), c.out, c.text.slice(0, 80));
});
test("fullText matches Python, cutting long replies early enough to keep the suffix", () => {
  for (const c of fx.full) {
    if (c.out && len(c.out) > FULL_MAX_CHARS) sameCutWithinCap(fullText(c.text)!, c.out, c.text.slice(0, 80));
    else assert.equal(fullText(c.text), c.out, c.text.slice(0, 80));
  }
});

test("a full-mode cut near 6000 keeps 'The rest is on screen.' through the speech cap", () => {
  // Sentences end at code point 5986: a cut there plus the suffix would pass 6000.
  const sentence = "x".repeat(97) + ". "; // 99 code points with its space
  const text = sentence.repeat(60).slice(0, 5940) + "y".repeat(44) + ". " + "z".repeat(500) + ".";
  assert.equal(text.indexOf(". ", 5940), 5984);
  const out = fullText(text)!;
  assert.ok(out.endsWith(REST));
  assert.ok(len(out) <= FULL_MAX_CHARS);
  assert.equal(capSpeech(out), out, "capping again changes nothing");
});
test("last valid directive wins and fenced ones are ignored", () => {
  const t = 'a\n```\n::kokoro-tts{weight="speech" say="fenced"}\n```\n::kokoro-tts{weight="speech" say="one"}\n::kokoro-tts{weight="sound:done"}\n';
  assert.deepEqual(extractDirective(t), ["sound:done", null]);
});
test("CRLF directive line parses", () => {
  assert.deepEqual(extractDirective('x\r\n::kokoro-tts{weight="speech" say="hi"}\r\n'), ["speech", "hi"]);
});
test("ambient caps speech at the attention ping, which falls back to done when pings are off", () => {
  assert.deepEqual(route('::kokoro-tts{weight="speech" say="x"}', "ambient", { working_sound: true, attention_sound: false }), { action: "sound", sound: "done" });
});
test("applyCuePrefs leaves speech alone", () => {
  assert.deepEqual(applyCuePrefs({ action: "speech", text: "a" }, { working_sound: false, attention_sound: false }), { action: "speech", text: "a" });
});
test("full mode ignores directives", () => {
  assert.deepEqual(routeTurn('Hello there.\n::kokoro-tts{weight="silent"}', "full"), { action: "speech", text: "Hello there." });
});
test("conversational and verbose route like brief (ceiling 4)", () => {
  const on = { working_sound: true, attention_sound: true };
  for (const mode of ["conversational", "verbose"] as const) {
    assert.deepEqual(route('Done.\n::kokoro-tts{weight="speech" say="Tests pass."}', mode, on), { action: "speech", text: "Tests pass." }, mode);
    assert.deepEqual(route('Done.\n::kokoro-tts{weight="sound:attention"}', mode, on), { action: "sound", sound: "attention" }, mode);
    assert.deepEqual(route('Done.\n::kokoro-tts{weight="speech" say="Tests pass."}', mode, on), route('Done.\n::kokoro-tts{weight="speech" say="Tests pass."}', "brief", on), mode);
  }
});

test("a directive say is capped at FULL_MAX_CHARS, cut at a sentence end", () => {
  const sentence = "This sentence is exactly forty characters. ";
  const say = sentence.repeat(500).trim(); // about 21,500 characters
  const r = routeTurn(`Done.\n::kokoro-tts{weight="speech" say="${say}"}`, "brief");
  assert.equal(r.action, "speech");
  const text = (r as { text: string }).text;
  assert.ok(Array.from(text).length <= FULL_MAX_CHARS);
  assert.ok(Array.from(text).length > FULL_MAX_CHARS - sentence.length);
  assert.ok(text.endsWith("characters."));
});

test("capSpeech leaves short text alone and cuts long text without a sentence end hard", () => {
  assert.equal(capSpeech("Short."), "Short.");
  const long = "x".repeat(FULL_MAX_CHARS + 50);
  assert.equal(capSpeech(long), "x".repeat(FULL_MAX_CHARS));
  // Code points, not UTF-16 units.
  assert.equal(Array.from(capSpeech("😀".repeat(FULL_MAX_CHARS + 1))).length, FULL_MAX_CHARS);
});
