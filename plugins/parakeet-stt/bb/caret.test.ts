import { test } from "node:test";
import assert from "node:assert/strict";
import { locateCaret, type DomNode } from "./caret.ts";

const t = (data: string): DomNode => ({ nodeType: 3, nodeName: "#text", data, childNodes: [] });
const el = (name: string, children: DomNode[], cls = ""): DomNode => ({ nodeType: 1, nodeName: name, childNodes: children, className: cls });

test("caret inside the second paragraph maps to a draft offset", () => {
  const second = t("second line");
  const root = el("DIV", [el("P", [t("first")]), el("P", [second])]);
  const r = locateCaret(root, { node: second, offset: 6 }, { node: second, offset: 6 }, "first\nsecond line");
  assert.deepEqual(r, { start: 12, end: 12 });
});

test("selection gives start and end", () => {
  const txt = t("fix the bug now");
  const root = el("DIV", [el("P", [txt])]);
  assert.deepEqual(locateCaret(root, { node: txt, offset: 8 }, { node: txt, offset: 11 }, "fix the bug now"), { start: 8, end: 11 });
});

test("hard breaks count as newlines; trailing breaks are ignored", () => {
  const after = t("b");
  const root = el("DIV", [el("P", [t("a"), el("BR", []), after, el("BR", [], "ProseMirror-trailingBreak")])]);
  assert.deepEqual(locateCaret(root, { node: after, offset: 1 }, { node: after, offset: 1 }, "a\nb"), { start: 3, end: 3 });
});

test("caret addressed at the root (between blocks)", () => {
  const root = el("DIV", [el("P", [t("one")]), el("P", [t("two")])]);
  assert.deepEqual(locateCaret(root, { node: root, offset: 1 }, { node: root, offset: 1 }, "one\ntwo"), { start: 4, end: 4 });
});

test("paragraphs joined by a blank line are also recognised", () => {
  const two = t("two");
  const root = el("DIV", [el("P", [t("one")]), el("P", [two])]);
  assert.deepEqual(locateCaret(root, { node: two, offset: 0 }, { node: two, offset: 0 }, "one\n\ntwo"), { start: 5, end: 5 });
});

test("editor that does not reproduce the draft -> null (append at end)", () => {
  const txt = t("hello");
  const root = el("DIV", [el("P", [txt])]);
  assert.equal(locateCaret(root, { node: txt, offset: 2 }, { node: txt, offset: 2 }, "hello @someone"), null);
});
