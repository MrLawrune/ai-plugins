import { test } from "node:test";
import assert from "node:assert/strict";
import { runCapture, startStreaming } from "./process.ts";

test("runCapture collects stdout, stderr, and the exit code", async () => {
  const r = await runCapture("bash", ["-c", "printf out; printf err >&2; exit 4"]);
  assert.deepEqual(r, { code: 4, signal: null, stdout: "out", stderr: "err" });
});

test("runCapture rejects with too_large when output exceeds maxBytes", async () => {
  await assert.rejects(runCapture("bash", ["-c", "head -c 5000 /dev/zero"], { maxBytes: 1000 }), /^Error: too_large/);
});

test("runCapture rejects on timeout and abort", async () => {
  await assert.rejects(runCapture("sleep", ["5"], { timeoutMs: 100 }), /^Error: timeout/);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(runCapture("sleep", ["5"], { signal: ac.signal }), /^Error: aborted/);
});

test("runCapture rejects when the command cannot start", async () => {
  await assert.rejects(runCapture("/nonexistent/binary-xyz", []), /ENOENT/);
});

test("startStreaming forwards stdout and stderr lines and reports exit", async () => {
  const lines: string[] = [];
  const exit = new Promise<{ code: number | null; signal: string | null }>((res) => {
    startStreaming("bash", ["-c", "echo a; echo oops >&2; printf 'b'; exit 2"], { onLine: (l) => lines.push(l), onExit: (code, signal) => res({ code, signal }) });
  });
  assert.deepEqual(await exit, { code: 2, signal: null });
  assert.deepEqual(lines.filter((l) => !l.startsWith("stderr: ")), ["a", "b"]);
  assert.deepEqual(lines.filter((l) => l.startsWith("stderr: ")), ["stderr: oops"]);
});

test("startStreaming kill stops the whole process group", async () => {
  const exit = new Promise<{ code: number | null; signal: string | null }>((res) => {
    const s = startStreaming("bash", ["-c", "sleep 30; echo never"], { onLine: () => {}, onExit: (code, signal) => res({ code, signal }) });
    assert.ok(s.pid > 0);
    setTimeout(() => s.kill(), 50);
  });
  const r = await exit;
  assert.equal(r.signal, "SIGTERM");
});
