import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { followBottom } from "./follow-bottom.ts";

let observed: Node[];
let el: HTMLElement;
let top: number;
const RealMO = MutationObserver;

beforeEach(() => {
  observed = [];
  vi.stubGlobal("MutationObserver", class extends RealMO {
    observe(target: Node, options?: MutationObserverInit) {
      observed.push(target);
      super.observe(target, options);
    }
  });
  document.body.innerHTML = `<div id="el"></div>`;
  el = document.getElementById("el")!;
  top = 0;
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => 200 },
    clientHeight: { configurable: true, get: () => 100 },
    scrollTop: { configurable: true, get: () => top, set: (v: number) => { top = v; } },
  });
});

afterEach(() => vi.unstubAllGlobals());

const tick = () => new Promise((r) => setTimeout(r, 0));

test("observes only the element it was given, never the document or body", () => {
  followBottom(el, new AbortController().signal);
  expect(observed).toEqual([el]);
});

test("content added under the element keeps it pinned to the bottom", async () => {
  followBottom(el, new AbortController().signal);
  el.append(document.createElement("p"));
  await tick();
  expect(top).toBe(200);
});

test("attaching scrolls to the bottom once, so a write made just before it is visible", () => {
  followBottom(el, new AbortController().signal);
  expect(top).toBe(200);
});

test("after the user scrolls up, new content no longer moves it", async () => {
  followBottom(el, new AbortController().signal);
  top = 0;
  el.dispatchEvent(new Event("scroll"));
  el.append(document.createElement("p"));
  await tick();
  expect(top).toBe(0);
});

test("aborting stops following", async () => {
  const ctl = new AbortController();
  followBottom(el, ctl.signal);
  top = 50;
  ctl.abort();
  el.append(document.createElement("p"));
  await tick();
  expect(top).toBe(50);
});
