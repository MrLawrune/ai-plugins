import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { toast } from "sonner";
import { forgetWatched, isWatched, LOADING_BACKSTOP_MS, refreshFailed, updateWatched, watchAction, watchedIds } from "./action-toasts.ts";
import type { ActionDto } from "../schemas.ts";

const row = (over: Partial<ActionDto>): ActionDto => ({
  id: "a1", envId: "e", connectionId: "c", target: "lab/pve1/201", guestName: "proxy", action: "stop", params: {}, confirm: "dialog",
  sourceSurface: "page", sourceThreadId: null, credential: "action", upid: "UPID:x", status: "running", exitstatus: null, error: null,
  lastLine: null, requestedAt: 0, endedAt: null, ...over,
});

const loading = mock.method(toast, "loading", () => "");
const success = mock.method(toast, "success", () => "");
const warning = mock.method(toast, "warning", () => "");
const dismiss = mock.method(toast, "dismiss", () => "");
const warn = mock.method(console, "warn", () => undefined);

test("open actions are watched and final toasts inherit no loading duration", () => {
  watchAction(row({ id: "w1" }));
  assert.deepEqual(watchedIds(), ["w1"]);
  const opts = loading.mock.calls.at(-1)!.arguments[1] as { id: string; duration?: number };
  assert.equal(opts.id, "w1");
  assert.equal(opts.duration, undefined, "sonner merges options by id, so a loading duration would stick to the final toast");
  updateWatched(row({ id: "w1", status: "ok", endedAt: 1 }));
  assert.equal(isWatched("w1"), false);
  assert.equal(success.mock.callCount(), 1);
  assert.equal((success.mock.calls[0]!.arguments[1] as { duration?: number }).duration, undefined, "no duration may carry over from the loading toast");
});

test("a loading toast with no final signal is replaced by a warning after the backstop", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    watchAction(row({ id: "b1" }));
    watchAction(row({ id: "b2" }));
    updateWatched(row({ id: "b2", status: "ok", endedAt: 1 }));
    mock.timers.tick(LOADING_BACKSTOP_MS - 1);
    assert.equal(warning.mock.callCount(), 0);
    mock.timers.tick(1);
    assert.equal(isWatched("b1"), false);
    assert.equal(warning.mock.callCount(), 1, "only the still-open action is warned about");
    assert.equal((warning.mock.calls[0]!.arguments[1] as { id: string }).id, "b1");
    assert.equal(warning.mock.calls[0]!.arguments[0], "Still running: Stopping proxy");
  } finally {
    mock.timers.reset();
  }
});

test("refresh failures warn once per id and keep watching", () => {
  watchAction(row({ id: "w2" }));
  refreshFailed("w2", new Error("offline"));
  refreshFailed("w2", new Error("offline"));
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(isWatched("w2"), true);
});

test("a vanished action is forgotten and its toast dismissed", () => {
  forgetWatched("w2");
  assert.equal(isWatched("w2"), false);
  assert.deepEqual(dismiss.mock.calls.at(-1)!.arguments, ["w2"]);
});
