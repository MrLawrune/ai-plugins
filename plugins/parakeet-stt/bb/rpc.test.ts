import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { DictationLog } from "./dictation-log.ts";
import { PrefsStore } from "./prefs.ts";
import { rpcContract } from "./contract.ts";
import { MODEL_LOADING } from "./schemas.ts";
import { createRpcHandlers, type RpcDeps } from "./rpc.ts";
import { createSttClient, SttError, type SttClient } from "./stt-client.ts";
import { memKv } from "./test-kv.ts";

type SetCall = { serverUrl?: string | null; apiKey?: string | null };

async function setup(client: Partial<SttClient>, configured = true, server: Partial<RpcDeps["server"]> = {}, signal: AbortSignal = new AbortController().signal) {
  const kv = memKv();
  const prefs = new PrefsStore(kv);
  await prefs.load();
  await prefs.update("desktop", { customWords: ["tmux"] });
  const db = new Database(":memory:");
  const history = new DictationLog({
    db: () => db,
    migrate: (d, stmts) => { for (const sql of stmts) d.exec(sql); },
    limits: () => ({ maxEntries: prefs.get().historyMaxEntries, maxAgeDays: prefs.get().historyMaxAgeDays }),
    now: () => 1_800_000_000_000,
  });
  history.init();
  let t = 1000;
  const sets: SetCall[] = [];
  let url = configured ? "https://stt.example" : "";
  let key = "";
  const handlers = createRpcHandlers({
    client: () => client as SttClient, configured: () => configured, prefs, history, kv, now: () => (t += 50), signal,
    server: {
      get: () => ({ serverUrl: url, apiKey: key || undefined }),
      async set(v: SetCall) {
        sets.push(v);
        if (v.serverUrl !== undefined) url = v.serverUrl ?? "";
        if (v.apiKey !== undefined) key = v.apiKey ?? "";
      },
      needsConfiguration: false,
      ...server,
    },
  });
  return { handlers, history, kv, sets };
}

test("transcribe decodes base64, applies prefs, records history", async () => {
  let got: { bytes: string; words: string[] } | null = null;
  const { handlers, history } = await setup({
    async transcribe(audio, _m, _f, opts) { got = { bytes: Buffer.from(audio).toString(), words: opts.customWords }; return "hello"; },
  });
  const out = await handlers.transcribe({ audioBase64: Buffer.from("abc").toString("base64"), mimeType: "audio/webm", filename: "x.webm" });
  assert.equal(out.text, "hello");
  assert.equal(out.durationMs, 50);
  assert.deepEqual(got, { bytes: "abc", words: ["tmux"] });
  assert.deepEqual(history.list().map((e) => [e.text, e.source]), [["hello", "oneshot"]]);
});

test("empty transcript is returned but not stored", async () => {
  const { handlers, history } = await setup({ async transcribe() { return ""; } });
  assert.equal((await handlers.transcribe({ audioBase64: "YQ==", mimeType: "a", filename: "b" })).text, "");
  assert.deepEqual(history.list(), []);
});

test("transcribe errors surface the server message", async () => {
  const { handlers } = await setup({ async transcribe() { throw new SttError("unauthorized", "Parakeet STT: Invalid or missing API key", 401); } });
  await assert.rejects(handlers.transcribe({ audioBase64: "YQ==", mimeType: "a", filename: "b" }), /Invalid or missing API key/);
});

test("health reports not configured without calling the server", async () => {
  const { handlers } = await setup({ async health() { throw new Error("should not be called"); } }, false);
  const h = await handlers.health();
  assert.equal(h.configured, false);
  assert.equal(h.up, false);
});

test("health marks a server that answered but is not ready with the shared loading marker", async () => {
  const { handlers } = await setup({ async health() { return { status: "loading", ready: false, model: "m", version: "1", uptime_s: 1 }; } });
  const h = await handlers.health();
  assert.equal(h.up, false);
  assert.equal(h.error, MODEL_LOADING);
});

test("health reports server errors as down", async () => {
  const { handlers } = await setup({ async health() { throw new SttError("unreachable", "unreachable at x", null); } });
  const h = await handlers.health();
  assert.deepEqual([h.configured, h.up, h.error], [true, false, "unreachable at x"]);
});

test("listHistory and clearHistory read and empty the log", async () => {
  const { handlers, history } = await setup({});
  history.add({ text: "x", durationMs: 1, source: "stream", deviceId: null });
  assert.deepEqual((await handlers.listHistory()).entries.map((e) => [e.text, e.source]), [["x", "stream"]]);
  assert.deepEqual(await handlers.clearHistory(), { cleared: true });
  assert.deepEqual((await handlers.listHistory()).entries, []);
});

test("getNote returns the migration note until dismissNote deletes it", async () => {
  const { handlers, kv } = await setup({});
  assert.deepEqual(await handlers.getNote(), { note: null });
  await kv.set("migration-note", "Moved.");
  assert.deepEqual(await handlers.getNote(), { note: "Moved." });
  assert.deepEqual(await handlers.dismissNote(), { dismissed: true });
  assert.deepEqual(kv.deleted, ["migration-note"]);
  assert.deepEqual(await handlers.getNote(), { note: null });
  await kv.set("migration-note", 5);
  assert.deepEqual(await handlers.getNote(), { note: null });
});

test("getServer reports the URL and whether a key is set, never the key", async () => {
  const { handlers, sets } = await setup({});
  assert.deepEqual(await handlers.getServer(), { serverUrl: "https://stt.example", apiKeySet: false, needsReload: false });
  await handlers.setServer({ apiKey: "s3cret" });
  const out = await handlers.getServer();
  assert.equal(out.apiKeySet, true);
  assert.equal(JSON.stringify(out).includes("s3cret"), false);
  assert.deepEqual(sets, [{ apiKey: "s3cret" }]);
});

test("setServer rejects URLs that are not http(s)", async () => {
  const { handlers, sets } = await setup({});
  for (const bad of ["ftp://x", "not a url", "stt.example", "javascript:alert(1)"]) {
    await assert.rejects(handlers.setServer({ serverUrl: bad }), /Enter an http or https URL/, bad);
  }
  assert.deepEqual(sets, []);
});

test("the setServer contract passes any bounded string through, so the handler's message reaches the page", () => {
  const input = rpcContract.setServer.input;
  for (const v of ["ftp://x", "not a url", ""]) assert.equal(input.safeParse({ serverUrl: v }).success, true, v);
  assert.equal(input.safeParse({ serverUrl: "x".repeat(2049) }).success, false);
  assert.equal(input.safeParse({ serverUrl: 5 }).success, false);
  assert.deepEqual(input.parse({ serverUrl: "  http://stt.example  " }), { serverUrl: "http://stt.example" });
});

test("setServer writes a valid URL through settings and trims it; empty clears; null clears the key", async () => {
  const { handlers, sets } = await setup({});
  const out = await handlers.setServer({ serverUrl: " http://stt.example:9000/ " });
  assert.equal(out.serverUrl, "http://stt.example:9000/");
  await handlers.setServer({ serverUrl: "" });
  await handlers.setServer({ apiKey: null });
  assert.deepEqual(sets, [{ serverUrl: "http://stt.example:9000/" }, { serverUrl: "" }, { apiKey: null }]);
});

test("needsReload is true once a URL is set after the plugin was marked needs-configuration", async () => {
  const { handlers } = await setup({}, false, { needsConfiguration: true });
  assert.equal((await handlers.getServer()).needsReload, false);
  assert.equal((await handlers.setServer({ serverUrl: "https://stt.example" })).needsReload, true);
});

test("transcribe passes an abort signal that follows the scope signal", async () => {
  let got: AbortSignal | undefined;
  const ctl = new AbortController();
  const { handlers } = await setup({ async transcribe(_a, _m, _f, opts) { got = opts.signal; return "x"; } }, true, {}, ctl.signal);
  await handlers.transcribe({ audioBase64: "YQ==", mimeType: "a", filename: "b" });
  assert.equal(got!.aborted, false);
  ctl.abort();
  assert.equal(got!.aborted, true);
});

test("the real server's 503 loading response reads as Loading model, not as unreachable", async () => {
  const body = { status: "loading", version: "0.2.0", model: "parakeet-tdt-0.6b-v2", ready: false, uptime_s: 1 };
  const client = createSttClient({ serverUrl: "https://stt.example", apiKey: "" }, (async () => Response.json(body, { status: 503 })) as typeof fetch);
  const { handlers } = await setup(client);
  assert.deepEqual(await handlers.health(), { configured: true, up: false, model: body.model, version: "0.2.0", error: MODEL_LOADING, lastLatencyMs: null });
});
