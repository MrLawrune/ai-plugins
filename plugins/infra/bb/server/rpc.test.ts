import { test } from "node:test";
import assert from "node:assert/strict";
import { rpcContract } from "../schemas.ts";
import { fakeProvider, guest, host, inv, serviceHarness } from "../test-util.ts";
import { createRpcHandlers } from "./rpc.ts";

const provider = () => fakeProvider([inv([host("pve1", { ip: "192.0.2.10" })], [guest("pve1", 201, { name: "proxy" })])], {
  "pve1/201": { interfaces: [{ name: "eth0", mac: null, ipv4: ["192.0.2.201"], ipv6: [] }] },
});

test("contract rejects malformed targets and unknown fields at the boundary", () => {
  assert.equal(rpcContract.guest.input.safeParse({ target: "../x" }).success, false);
  assert.equal(rpcContract.guest.input.safeParse({ target: "homelab/pve1/201", extra: 1 }).success, false);
  assert.equal(rpcContract.guest.input.safeParse({ target: "homelab/pve1/201" }).success, true);
  assert.equal(rpcContract.connectionSave.input.safeParse({ envId: "e", label: "x", baseUrl: "http://x:8006", authKind: "token", username: "u", tlsMode: "insecure", tlsFingerprint: "", enabled: true }).success, false);
});

test("unknown targets return found:false instead of throwing", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: provider() } }]);
  const rpc = createRpcHandlers(h.service);
  for (const r of [await rpc.guest({ target: "homelab/pve1/999" }), await rpc.host({ target: "homelab/PV09" }), await rpc.env({ slug: "nope" }), await rpc.metrics({ target: "homelab", range: "hour" }), await rpc.askPrompt({ target: "x/y/1", intent: "ask" }), await rpc.guestSummary({ target: "homelab/pve1" })]) {
    assert.deepEqual(r, { found: false });
  }
});

test("found results carry data", async () => {
  const h = await serviceHarness([{ slug: "homelab", conns: { pve1: provider() } }]);
  const rpc = createRpcHandlers(h.service);
  const g = await rpc.guest({ target: "homelab/pve1/201" });
  assert.equal(g.found && g.detail.guest.name, "proxy");
  const e = await rpc.env({ slug: "homelab" });
  assert.equal(e.found && e.guests.length, 1);
  assert.equal((await rpc.overview()).envs.length, 1);
});

test("connection web UI link must be https when given", () => {
  const base = { envId: "e", label: "x", baseUrl: "https://192.0.2.1:8006", authKind: "token", username: "u@pve!t", tlsMode: "insecure", tlsFingerprint: "", enabled: true };
  assert.equal(rpcContract.connectionSave.input.safeParse({ ...base, webUrl: "" }).success, true);
  assert.equal(rpcContract.connectionSave.input.safeParse({ ...base, webUrl: "https://pve1.example.dev" }).success, true);
  assert.equal(rpcContract.connectionSave.input.safeParse({ ...base, webUrl: "javascript:alert(1)" }).success, false);
});
