import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyCuePrefs, extractDirective, firstSentence, fullText, route, routeCue, routeTurn } from "./turn.ts";
import type { Mode } from "../schemas.ts";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/turn.json", import.meta.url), "utf8"));

test("route matches Python for every fixture", () => {
  for (const c of fx.route) assert.deepEqual(route(c.text, c.mode as Mode, c.cfg), c.out, JSON.stringify(c.text).slice(0, 80) + " " + c.mode);
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
test("fullText matches Python", () => {
  for (const c of fx.full) assert.equal(fullText(c.text), c.out, c.text.slice(0, 80));
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
