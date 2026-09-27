import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLines, loadText } from "../../test-util.ts";
import { EventNormalizer, recapFromStats, statusFromExit } from "./normalize.ts";
import { LIMITS } from "../../shared/constants.ts";

const feed = (mode: "runner" | "jsonl" | "text", lines: string[]) => { const n = new EventNormalizer(mode); const out = lines.flatMap((l) => n.push(l, 1)); return [...out, ...n.finish()]; };

test("runner stream → play/task/host events with nodes and stats", () => {
  const ev = feed("runner", loadLines("runner_events.jsonl"));
  assert.equal(ev[0]!.kind, "playbook_start");
  const play = ev.find((e) => e.kind === "play_start")!; assert.equal(play.play, "Web servers");
  const task = ev.find((e) => e.kind === "task_start")!; assert.equal(task.task, "Gathering Facts");
  const install = ev.find((e) => e.kind === "task_start" && e.task === "Install packages")!; assert.equal(install.taskAction, "ansible.builtin.apt");
  const ok = ev.find((e) => e.kind === "host_ok")!; assert.ok(ok.host && ok.play && ok.task);
  const stats = ev.at(-1)!; assert.equal(stats.kind, "stats");
  const recap = recapFromStats(stats as never)!; assert.ok(recap["web-01"]!.ok >= 1);
  assert.equal(recap["db-01"]!.failures, 1);
  assert.ok(ev.every((e) => e.source === "events" && e.nodeId === null));
});
test("runner: ignore_errors failures are not failed; warnings and diffs are logs", () => {
  const ev = feed("runner", loadLines("runner_events.jsonl"));
  const failed = ev.filter((e) => e.kind === "host_failed");
  assert.ok(failed.some((e) => !e.failed && e.msg?.includes("nginx")));
  assert.ok(failed.some((e) => e.failed && e.host === "db-01" && e.msg));
  assert.ok(ev.some((e) => e.kind === "log" && e.stdout?.includes("[WARNING]")));
  assert.ok(ev.some((e) => e.kind === "host_ok" && e.changed && e.taskAction === "ansible.builtin.apt"));
});
test("non-JSON lines in runner mode become log events", () => {
  assert.equal(feed("runner", ["not json"])[0]!.kind, "log");
  assert.equal(feed("runner", ["{broken"])[0]!.kind, "log");
  assert.deepEqual(feed("runner", [""]), []);
});
test("posix jsonl stream", () => {
  const ev = feed("jsonl", loadLines("posix_jsonl.jsonl"));
  assert.ok(ev.some((e) => e.kind === "task_start") && ev.some((e) => e.kind === "host_ok") && ev.at(-1)!.kind === "stats");
  const ok = ev.find((e) => e.kind === "host_ok" && e.task === "Install packages")!;
  assert.equal(ok.play, "Web servers"); assert.equal(ok.taskAction, "ansible.builtin.apt"); assert.ok(ok.changed && ok.diff);
  assert.equal(recapFromStats(ev.at(-1) as never)!["db-01"]!.failures, 1);
});
test("text parser", () => {
  const ev = feed("text", loadText("text_log.txt").split("\n"));
  assert.equal(ev.find((e) => e.kind === "play_start")!.play, "Web servers");
  assert.equal(ev.find((e) => e.kind === "task_start")!.task, "Gathering Facts");
  const failed = ev.find((e) => e.kind === "host_failed"); if (failed) assert.ok(failed.msg);
  assert.equal(ev.at(-1)!.kind, "stats"); assert.ok(ev.every((e) => e.source === "text"));
  assert.equal(recapFromStats(ev.at(-1) as never)!["web-01"]!.ignored, 2);
});
test("text parser: an unbalanced `=> {` result is capped instead of swallowing the rest of the log", () => {
  const lines = ["PLAY [Web] ****", "TASK [Broken] ****", 'fatal: [web-01]: FAILED! => {"msg": "unterminated', ...Array.from({ length: 600 }, (_, i) => `  "line${i}": 1,`), "TASK [Next] ****", "ok: [web-01]", "PLAY RECAP ****", "web-01 : ok=1 changed=0 unreachable=0 failed=1 skipped=0 rescued=0 ignored=0"];
  const ev = feed("text", lines);
  const fail = ev.find((e) => e.kind === "host_failed")!;
  assert.ok(fail && fail.failed && fail.host === "web-01" && fail.task === "Broken");
  assert.match(fail.msg ?? "", /^\{"msg": "unterminated/);
  assert.ok((fail.msg ?? "").includes('"line0": 1'), "the collected text is kept on the event");
  assert.deepEqual(ev.filter((e) => e.kind === "task_start").map((e) => e.task), ["Broken", "Next"], "parsing resumes after the cap");
  assert.ok(ev.some((e) => e.kind === "host_ok" && e.task === "Next"));
  assert.equal(ev.at(-1)!.kind, "stats");
});

test("text parser: multi-line JSON, ...ignoring, skipping", () => {
  const ev = feed("text", loadText("text_log.txt").split("\n"));
  const dbg = ev.find((e) => e.kind === "host_ok" && e.host === "web-01" && e.task === "Common baseline")!;
  assert.equal(dbg.msg, "common role on web-01");
  assert.ok(ev.some((e) => e.kind === "host_failed" && e.host === "web-01" && !e.failed));
  assert.ok(ev.some((e) => e.kind === "host_failed" && e.host === "db-01" && e.failed));
  assert.ok(ev.some((e) => e.kind === "host_skipped"));
  assert.ok(ev.some((e) => e.kind === "host_ok" && e.changed && e.diff === null && e.stdout));
});
test("limits are enforced", () => {
  const big = "x".repeat(100_000);
  const line = JSON.stringify({ event: "runner_on_ok", stdout: "", event_data: { host: "h", task: "t", play: "p", res: { msg: big, changed: true, blob: big } } });
  const e = feed("runner", [line])[0]!;
  assert.ok(e.msg!.length <= LIMITS.msg && e.res!.length <= LIMITS.res);
  assert.ok(feed("runner", [JSON.stringify({ event: "verbose", stdout: big })])[0]!.stdout!.length <= LIMITS.stdout);
});
test("status from exit", () => {
  assert.equal(statusFromExit(0, true, false), "success"); assert.equal(statusFromExit(2, true, false), "failed");
  assert.equal(statusFromExit(null, false, true), "canceled"); assert.equal(statusFromExit(1, false, false), "failed");
});
