import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSummaryDto } from "../schemas.ts";
import { progressLine, runDetail, runRowText } from "./run-summary-model.ts";

const run = (over: Partial<RunSummaryDto> = {}): RunSummaryDto => ({
  id: "run_abc123", env: { slug: "lab", name: "Lab", kind: "lab", color: "#22c55e" }, playbook: "site.yml", playbookName: "Site", status: "failed",
  requestedAt: 0, startedAt: 0, endedAt: 1, source: { surface: "cli", threadId: null, scheduleId: null }, check: true,
  lastLine: '{"uuid": "9e747d9d", "counter": 53, "stdout": "PLAY RECAP"}', hosts: 3, failedHosts: 1, changedHosts: 2, ...over,
});

test("a finished run shows recap counts, never the raw stream line", () => {
  assert.equal(runRowText(run()), "Lab · failed · check · 3 hosts · 1 failed · 2 changed");
  assert.equal(runDetail(run({ check: false, hosts: 1, failedHosts: 0, changedHosts: 0 }), false), "failed · 1 host · 0 failed · 0 changed");
});

test("a run without a recap shows no line once finished", () => {
  assert.equal(runRowText(run({ hosts: null, failedHosts: null, changedHosts: null })), "Lab · failed · check");
});

test("a live run shows a truncated plain line and skips JSON objects", () => {
  const live = { status: "running", hosts: null, failedHosts: null, changedHosts: null } as const;
  assert.equal(runRowText(run({ ...live, lastLine: "TASK [Install nginx]" })), "Lab · running · check · TASK [Install nginx]");
  assert.equal(runRowText(run({ ...live })), "Lab · running · check");
  assert.equal(progressLine("x".repeat(200))?.length, 80);
});
