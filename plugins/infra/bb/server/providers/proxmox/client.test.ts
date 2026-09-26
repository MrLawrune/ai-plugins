import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { PveClient, PveError } from "./client.ts";
import { portOf, probeCertificate } from "./tls.ts";

const key = readFileSync(new URL("../../../fixtures/tls/key.pem", import.meta.url));
const cert = readFileSync(new URL("../../../fixtures/tls/cert.pem", import.meta.url));

type Reply = { status: number; json?: unknown };

async function server(handler: (req: IncomingMessage, body: string) => Reply, opts: { close?: boolean } = {}) {
  const seen: { path: string; auth?: string; cookie?: string }[] = [];
  const s = createServer({ key, cert }, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url!, auth: req.headers.authorization, cookie: req.headers.cookie });
      const r = handler(req, body);
      res.writeHead(r.status, { "content-type": "application/json", ...(opts.close ? { connection: "close" } : {}) });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `https://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

const isCode = (code: string) => (e: unknown) => e instanceof PveError && e.code === code;

test("token auth with a pinned certificate unwraps data", async () => {
  const srv = await server(() => ({ status: 200, json: { data: { version: "9.1.4" } } }));
  const { fingerprint256 } = await probeCertificate(srv.url);
  const c = new PveClient({ baseUrl: srv.url, auth: { kind: "token", tokenId: "bb-view@pve!infra", secret: "s3cr=t" }, tls: { mode: "pinned", fingerprint: fingerprint256 } });
  assert.deepEqual(await c.get("/version"), { version: "9.1.4" });
  assert.equal(srv.seen[0]!.path, "/api2/json/version");
  assert.equal(srv.seen[0]!.auth, "PVEAPIToken=bb-view@pve!infra=s3cr=t");
  await c.close(); await srv.close();
});

test("query parameters are encoded", async () => {
  const srv = await server(() => ({ status: 200, json: { data: [] } }));
  const c = new PveClient({ baseUrl: srv.url + "/", auth: { kind: "token", tokenId: "a@pve!b", secret: "x" }, tls: { mode: "insecure" } });
  await c.get("/nodes/pve1/tasks", { limit: 5, vmid: 201 });
  assert.equal(srv.seen[0]!.path, "/api2/json/nodes/pve1/tasks?limit=5&vmid=201");
  await c.close(); await srv.close();
});

test("pin mismatch fails before any request reaches the server", async () => {
  const srv = await server(() => ({ status: 200, json: { data: 1 } }));
  const c = new PveClient({ baseUrl: srv.url, auth: { kind: "token", tokenId: "a@pve!b", secret: "x" }, tls: { mode: "pinned", fingerprint: "AA:".repeat(31) + "AA" } });
  await assert.rejects(c.get("/version"), isCode("tls-mismatch"));
  assert.equal(srv.seen.length, 0);
  await c.close(); await srv.close();
});

test("an untrusted certificate in ca mode maps to tls-mismatch", async () => {
  const srv = await server(() => ({ status: 200, json: { data: 1 } }));
  const c = new PveClient({ baseUrl: srv.url, auth: { kind: "token", tokenId: "a@pve!b", secret: "x" }, tls: { mode: "ca", caPem: cert.toString() } });
  // Our own cert is issued for CN=localhost, so 127.0.0.1 fails hostname verification.
  await assert.rejects(c.get("/version"), isCode("tls-mismatch"));
  await c.close(); await srv.close();
});

test("401 maps to auth-failed; other errors to degraded", async () => {
  let status = 401;
  const srv = await server(() => ({ status }));
  const c = new PveClient({ baseUrl: srv.url, auth: { kind: "token", tokenId: "a@pve!b", secret: "x" }, tls: { mode: "insecure" } });
  await assert.rejects(c.get("/version"), isCode("auth-failed"));
  status = 500;
  await assert.rejects(c.get("/version"), isCode("degraded"));
  await c.close(); await srv.close();
});

test("refused connections map to unreachable", async () => {
  const dead = new PveClient({ baseUrl: "https://127.0.0.1:1", auth: { kind: "token", tokenId: "a@pve!b", secret: "x" }, tls: { mode: "insecure" }, timeoutMs: 1000 });
  await assert.rejects(dead.get("/version"), isCode("unreachable"));
  await dead.close();
});

test("password auth logs in once, sends the ticket cookie, and re-logs in after 401", async () => {
  let logins = 0; let reject = false; let loginBody = "";
  const srv = await server((req, body) => {
    if (req.url === "/api2/json/access/ticket") { logins++; loginBody = body; return { status: 200, json: { data: { ticket: `T${logins}`, CSRFPreventionToken: "c", username: "u@pam" } } }; }
    if (reject) { reject = false; return { status: 401 }; }
    return { status: 200, json: { data: [] } };
  });
  const c = new PveClient({ baseUrl: srv.url, auth: { kind: "password", username: "u@pam", password: "p w&=" }, tls: { mode: "insecure" } });
  await c.get("/nodes"); await c.get("/nodes");
  assert.equal(logins, 1);
  assert.equal(new URLSearchParams(loginBody).get("password"), "p w&=");
  assert.equal(srv.seen[1]!.cookie, "PVEAuthCookie=T1");
  reject = true; await c.get("/nodes");
  assert.equal(logins, 2);
  assert.equal(srv.seen.at(-1)!.cookie, "PVEAuthCookie=T2");
  await c.close(); await srv.close();
});

test("rejected login maps to auth-failed", async () => {
  const srv = await server(() => ({ status: 401 }));
  const c = new PveClient({ baseUrl: srv.url, auth: { kind: "password", username: "u@pam", password: "bad" }, tls: { mode: "insecure" } });
  await assert.rejects(c.get("/nodes"), isCode("auth-failed"));
  await c.close(); await srv.close();
});

test("pinned connections keep verifying when the TLS session is resumed on new sockets", async () => {
  const srv = await server(() => ({ status: 200, json: { data: 1 } }), { close: true });
  const { fingerprint256 } = await probeCertificate(srv.url);
  const c = new PveClient({ baseUrl: srv.url, auth: { kind: "token", tokenId: "a@pve!b", secret: "x" }, tls: { mode: "pinned", fingerprint: fingerprint256 } });
  try {
    for (let i = 0; i < 4; i++) assert.equal(await c.get("/version"), 1);
    await Promise.all([c.get("/a"), c.get("/b"), c.get("/c")]);
  } finally {
    await c.close(); await srv.close();
  }
});

test("the certificate probe uses the same port as requests", () => {
  assert.equal(portOf("https://pve.example.com/"), 443);
  assert.equal(portOf("https://192.0.2.1:8006"), 8006);
});
