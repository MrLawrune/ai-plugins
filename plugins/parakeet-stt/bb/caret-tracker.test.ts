import { test } from "node:test";
import assert from "node:assert/strict";
import { CaretMoves } from "./caret-tracker.ts";

test("a user caret change after a plugin edit counts as moved", () => {
  const m = new CaretMoves(300);
  m.pluginEdit(1000);
  m.selectionChanged(1100); // caused by the plugin's own edit
  assert.equal(m.take(), false);
  m.selectionChanged(2000); // user tapped at the end
  assert.equal(m.take(), true);
  assert.equal(m.take(), false, "consumed");
});

test("with no plugin edits, any selection change counts", () => {
  const m = new CaretMoves(300);
  m.selectionChanged(50);
  assert.equal(m.take(), true);
});

test("explicit user input inside the composer always counts", () => {
  const m = new CaretMoves(300);
  m.pluginEdit(1000);
  m.userInput();
  assert.equal(m.take(), true);
});
