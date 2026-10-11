// The backend entry point against a fake bb: what survives a failing history database or storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "./server.ts";
import { DEFAULT_PREFS } from "./prefs.ts";
import { fakeBb } from "./test-bb.ts";
import { memKv } from "./test-kv.ts";

const legacy = (historyLimit = 0) => ({
  "profiles-v1": {
    shared: { customWords: ["tmux", "zellij"], historyLimit },
    profiles: { desktop: { name: "Desktop", prefs: {} } },
    devices: {},
  },
  history: [{ id: "a", text: "earlier", at: 5, durationMs: 1 }],
});
const hello = { deviceId: "dev1", name: "Laptop", kind: "desktop" as const };

test("a failing history database does not stop the plugin: settings, relay and voice still register", async () => {
  const fake = fakeBb({ kv: memKv(legacy(5)), database: () => { throw new Error("db open failed"); } });
  await plugin(fake.bb);
  assert.ok(fake.reg.rpc && fake.reg.ai && fake.reg.ws);
  assert.ok(fake.logs.warn.some((m) => m.includes("db open failed")), fake.logs.warn.join("|"));
  const out = await fake.reg.rpc.hello(hello as never) as { prefs: { customWords: string[]; historyMaxEntries: number } };
  assert.deepEqual(out.prefs.customWords, ["tmux", "zellij"]);
  assert.equal(out.prefs.historyMaxEntries, 5);
  await assert.rejects(fake.reg.rpc.listHistory(null as never), /history is unavailable/i);
  // The old history row is kept for the next load.
  assert.ok(fake.kv.data.history);
  await fake.dispose();
});

test("a failed migration write keeps the legacy values: failure, load, hello, reload", async () => {
  const kv = memKv(legacy());
  const realSet = kv.set.bind(kv);
  let failures = 1;
  kv.set = async (k, v) => { if (k === "settings" && failures-- > 0) throw new Error("disk full"); return realSet(k, v); };
  const first = fakeBb({ kv });
  await plugin(first.bb);
  const out = await first.reg.rpc.hello(hello as never) as { prefs: { customWords: string[]; historyMaxEntries: number } };
  assert.deepEqual(out.prefs.customWords, ["tmux", "zellij"]);
  assert.equal(out.prefs.historyMaxEntries, 0);
  await first.dispose();
  const second = fakeBb({ kv });
  await plugin(second.bb);
  const prefs = await second.reg.rpc.getPrefs({ profileId: "desktop" } as never) as { customWords: string[]; historyMaxEntries: number };
  assert.deepEqual(prefs.customWords, ["tmux", "zellij"]);
  assert.equal(prefs.historyMaxEntries, 0);
  await second.dispose();
});

test("an unreadable settings row loads read-only defaults and never writes over the stored values", async () => {
  const kv = memKv({ settings: { v: 2, shared: { customWords: ["keep"] }, profiles: { desktop: { name: "Desktop", prefs: {} } } } });
  const realGet = kv.get.bind(kv);
  let broken = true;
  kv.get = (async (k: string) => { if (k === "settings" && broken) throw new Error("kv down"); return realGet(k); }) as typeof kv.get;
  const stored = structuredClone(kv.data.settings);
  const fake = fakeBb({ kv });
  await plugin(fake.bb);
  assert.ok(fake.logs.warn.some((m) => m.includes("kv down")), fake.logs.warn.join("|"));
  const out = await fake.reg.rpc.hello(hello as never) as { prefs: unknown };
  assert.deepEqual(out.prefs, DEFAULT_PREFS);
  await assert.rejects(fake.reg.rpc.setPrefs({ profileId: "desktop", patch: { autoSubmit: true } } as never), /unavailable/i);
  assert.deepEqual(kv.data.settings, stored);
  // Once the read works again the next write starts from the stored values.
  broken = false;
  const next = await fake.reg.rpc.setPrefs({ profileId: "desktop", patch: { autoSubmit: true } } as never) as { customWords: string[]; autoSubmit: boolean };
  assert.deepEqual(next.customWords, ["keep"]);
  assert.equal(next.autoSubmit, true);
  await fake.dispose();
});
