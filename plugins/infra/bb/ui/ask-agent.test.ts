import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_MENU, labelFor } from "./ask-model.ts";

test("menu offers ask, investigate, troubleshoot in order", () => {
  assert.deepEqual(ASK_MENU.map((m) => m.intent), ["ask", "investigate", "troubleshoot"]);
});

test("labels name the target kind", () => {
  assert.equal(labelFor("ask", "guest"), "Ask an agent about this guest");
  assert.equal(labelFor("troubleshoot", "env"), "Troubleshoot this environment");
});
