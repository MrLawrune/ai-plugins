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
const dismiss = mock.method(toast, "dismiss", () => "");
const warn = mock.method(console, "warn", () => undefined);

test("open actions are watched and their loading toast has a backstop duration", () => {
  watchAction(row({ id: "w1" }));
  assert.deepEqual(watchedIds(), ["w1"]);
  const opts = loading.mock.calls.at(-1)!.arguments[1] as { id: string; duration: number };
  assert.equal(opts.id, "w1");
  assert.equal(opts.duration, LOADING_BACKSTOP_MS);
  updateWatched(row({ id: "w1", status: "ok", endedAt: 1 }));
  assert.equal(isWatched("w1"), false);
  assert.equal(success.mock.callCount(), 1);
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
