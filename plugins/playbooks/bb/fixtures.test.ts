import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, loadLines, loadText, parseRunnerLines } from "./test-util.ts";

const TEXT_FIXTURES = ["runner_events.jsonl", "posix_jsonl.jsonl", "text_log.txt", "inventory_list.json"];

test("runner stream is JSON events with interleaved raw lines and ends with stats", () => {
  const { events, raw } = parseRunnerLines(loadLines("runner_events.jsonl"));
  assert.equal(events[0]!.event, "playbook_on_start");
  assert.equal(events.at(-1)!.event, "playbook_on_stats");
  // ansible-runner -j is not pure JSON: ansible warnings can reach stdout as raw text.
  assert.ok(raw.length >= 1, "fixture keeps at least one raw non-JSON line");
  assert.ok(raw.every((l) => l.startsWith("[WARNING]")));
  const counters = events.map((e) => e.counter as number);
  assert.ok(counters.every((c, i) => i === 0 || c > counters[i - 1]!), "counters increase");
});

test("runner stream covers both plays, a handler, a diff, and failures", () => {
  const { events } = parseRunnerLines(loadLines("runner_events.jsonl"));
  const kinds = new Set(events.map((e) => e.event as string));
  for (const k of ["playbook_on_play_start", "playbook_on_task_start", "runner_on_start", "runner_on_ok", "runner_on_failed", "runner_on_skipped", "runner_on_file_diff", "playbook_on_notify", "verbose"]) {
    assert.ok(kinds.has(k), `has ${k}`);
  }
  const plays = events.filter((e) => e.event === "playbook_on_play_start").map((e) => (e.event_data as { name: string }).name);
  assert.deepEqual(plays, ["Web servers", "Database"]);
});

test("posix jsonl callback is one JSON object per line ending with stats", () => {
  const events = loadLines("posix_jsonl.jsonl").map((l) => JSON.parse(l) as { _event: string });
  assert.equal(events[0]!._event, "v2_playbook_on_play_start");
  assert.equal(events.at(-1)!._event, "v2_playbook_on_stats");
});

test("text log has plays, tasks, and a recap", () => {
  const t = loadText("text_log.txt");
  assert.match(t, /^PLAY \[Web servers\]/m);
  assert.match(t, /^TASK \[Gathering Facts\]/m);
  assert.match(t, /^PLAY RECAP/m);
  assert.match(t, /^db-01\s+: ok=\d+/m);
});

test("fixtures carry no lab data", () => {
  for (const name of TEXT_FIXTURES) {
    const t = loadText(name);
    assert.doesNotMatch(t, /\b10\.\d+\.\d+\.\d+\b|\b192\.168\.\d+\.\d+\b|\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/, `${name} rfc1918`);
    assert.doesNotMatch(t, /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/, `${name} cgnat`);
    assert.doesNotMatch(t, /\bfd[0-9a-f]{2}:|\bfe80:/i, `${name} ula or link-local`);
    assert.doesNotMatch(t, /\/home\/(?!deploy)/, `${name} home dirs`);
    assert.doesNotMatch(t, /\/srv\/(?!example\b)/, `${name} srv paths`);
    assert.doesNotMatch(t, /\/root\b/, `${name} root home`);
    assert.doesNotMatch(t, /"(user|USER|LOGNAME|ansible_user_id)": "(?!deploy")/, `${name} users`);
    assert.doesNotMatch(t, /\bpve\b|pv0[1-9]|proxmox/i, `${name} hypervisor names`);
  }
  const inv = loadFixture("inventory_list.json") as { _meta: { hostvars: Record<string, { ansible_host: string }> } };
  assert.ok(inv._meta);
  for (const [host, vars] of Object.entries(inv._meta.hostvars)) {
    assert.ok(["web-01", "web-02", "db-01"].includes(host), host);
    assert.match(vars.ansible_host, /^192\.0\.2\.\d+$/);
  }
});

test("sample playbooks parse except broken.yml", async () => {
  const { parse } = await import("yaml");
  for (const name of ["site.yml", "blocks.yml", "roles-includes.yml", "import.yml"]) {
    const doc = parse(loadText(`playbooks/${name}`)) as unknown[];
    assert.ok(Array.isArray(doc) && doc.length > 0, name);
  }
  assert.throws(() => parse(loadText("playbooks/broken.yml")), { name: "YAMLParseError" });
});
