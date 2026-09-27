import { test } from "node:test";
import assert from "node:assert/strict";
import { createMention } from "./mention.ts";

const ctx = (query: string) => ({ trigger: "@" as const, query, projectId: null, threadId: "thr_1" });

test("resolve never throws when the host is unreachable", async () => {
  const m = createMention({ context: async () => { throw new Error("ssh: connect timed out"); }, items: () => [] });
  const r = await m.resolve("lab/site.yml#p0/t1");
  assert.match(r.context, /unavailable.*connect timed out/s);
  assert.match(r.context, /bb playbooks context lab\/site\.yml#p0\/t1/);
});

test("resolve returns the rendered context", async () => {
  const m = createMention({ context: async (id) => `## Playbooks context — ${id}\nenv: lab`, items: () => [] });
  assert.deepEqual(await m.resolve("lab"), { context: "## Playbooks context — lab\nenv: lab" });
  assert.equal(m.id, "playbooks");
  assert.equal(m.label, "Playbooks");
});

test("resolve survives a throwing items provider and non-Error throws", async () => {
  const m = createMention({ context: async () => { throw "boom"; }, items: () => { throw new Error("no"); } });
  assert.match((await m.resolve("lab")).context, /unavailable.*boom/s);
  assert.deepEqual(await m.search(ctx("")), []);
});

test("search filters by query and caps at 20", async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i < 15 ? `lab/site-${i}.yml` : `lab/db-${i}.yml`, title: i < 15 ? `Site ${i}` : `Db ${i}`, subtitle: "lab" }));
  const m = createMention({ context: async () => "", items: () => items });
  assert.equal((await m.search(ctx(""))).length, 20);
  const site = await m.search(ctx("SITE"));
  assert.equal(site.length, 15);
  assert.ok(site.every((i) => i.id.includes("site")));
  assert.equal((await m.search(ctx("Db 2"))).length, 10);
  assert.deepEqual(await m.search(ctx("zzz")), []);
});

test("search passes the thread and project through to the items provider", async () => {
  let seen: unknown = null;
  const m = createMention({ context: async () => "", items: (c) => { seen = c; return []; } });
  await m.search({ trigger: "@", query: "x", projectId: "proj_1", threadId: null });
  assert.deepEqual(seen, { query: "x", projectId: "proj_1", threadId: null });
});
