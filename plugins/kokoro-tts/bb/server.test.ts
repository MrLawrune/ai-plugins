import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { isLocalRequest } from "./server.ts";

test("server registers the player socket and sound routes", async () => {
  const host = createFakePluginHost();
  try {
    await plugin(host.bb);
    const routes = host.harness.registrations.httpRoutes.map((r) => `${r.method} ${r.path}`);
    assert.ok(routes.includes("GET /sound/attention"), routes.join(", "));
    assert.deepEqual(host.harness.registrations.websocketRoutes.map((r) => r.path), ["/player"]);
    const res = await host.harness.fetchHttp("GET", "/sound/done");
    assert.equal(res.headers.get("content-type"), "audio/wav");
  } finally {
    await host.harness.dispose();
  }
});

test("a player socket is local when its browser's address is this computer's", () => {
  const ours = new Set(["127.0.0.1", "::1", "192.0.2.10"]);
  const h = (o: Record<string, string> = {}) => new Headers(o);
  const url = new URL("http://localhost:4000/x");
  assert.equal(isLocalRequest(url, h(), ours), true, "direct loopback");
  assert.equal(isLocalRequest(new URL("http://[::1]:4000/x"), h(), ours), true);
  assert.equal(isLocalRequest(url, h({ "x-forwarded-for": "192.0.2.10" }), ours), true, "desktop via the reverse proxy");
  assert.equal(isLocalRequest(url, h({ "x-forwarded-for": "::ffff:192.0.2.10, 198.51.100.1" }), ours), true);
  assert.equal(isLocalRequest(url, h({ "x-forwarded-for": "192.0.2.77" }), ours), false, "a phone via the proxy");
  assert.equal(isLocalRequest(new URL("https://bb.example.com/x"), h(), ours), false);
});
