import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeProvider, guest, host, inv, serviceHarness } from "../test-util.ts";
import { createMention } from "./mention.ts";

test("search finds envs, hosts, and guests; resolve returns a card or throws", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: fakeProvider([inv([host("pve1")], [guest("pve1", 201, { name: "proxy" })])]) } }]);
  const m = createMention(h.service);
  const items = await m.search({ trigger: "@", query: "prox" } as never);
  assert.deepEqual(items.map((i) => i.id), ["homelab/pve1/201"]);
  assert.equal(items[0]!.title, "proxy");
  assert.equal((await m.search({ trigger: "@", query: "" } as never)).length, 3);
  assert.match((await m.resolve("homelab/pve1/201")).context, /^homelab\/pve1\/201 proxy/);
  await assert.rejects(async () => m.resolve("homelab/pve1/999"), /unknown target/);
});
