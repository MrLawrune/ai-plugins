import { test } from "node:test";
import assert from "node:assert/strict";
import { LoadScope } from "./lifecycle.ts";

test("dispose aborts the signal and resolves after tracked work settles", async () => {
  const scope = new LoadScope();
  let release!: () => void;
  const work = scope.track(new Promise<void>((r) => { release = r; }));
  let disposed = false;
  const done = scope.dispose().then(() => { disposed = true; });
  assert.equal(scope.signal.aborted, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(disposed, false, "still waiting on tracked work");
  release();
  await work;
  await done;
  assert.equal(disposed, true);
});

test("a rejected tracked promise neither blocks nor breaks dispose, and track passes it through", async () => {
  const scope = new LoadScope();
  await assert.rejects(scope.track(Promise.reject(new Error("boom"))), /boom/);
  await scope.dispose();
  assert.equal(scope.signal.aborted, true);
});

test("a never-settling promise does not block dispose beyond timeoutMs", async () => {
  const scope = new LoadScope();
  void scope.track(new Promise<void>(() => {}));
  const t0 = Date.now();
  await scope.dispose(30);
  assert.ok(Date.now() - t0 < 1000);
});

test("settled work is no longer tracked", async () => {
  const scope = new LoadScope();
  assert.equal(await scope.track(Promise.resolve(7)), 7);
  const t0 = Date.now();
  await scope.dispose(5_000);
  assert.ok(Date.now() - t0 < 100, "nothing left to wait for");
});
