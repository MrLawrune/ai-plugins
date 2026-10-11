import { test } from "node:test";
import assert from "node:assert/strict";
import { createSttClient, SttError } from "./stt-client.ts";

const cfg = { serverUrl: "https://stt.example/", apiKey: "k" };
const opts = { customWords: ["tmux"], removeFillers: true, correctionThreshold: 0.18, timeoutMs: 1000 };
const audio = new Uint8Array([1, 2, 3]);

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { f, calls };
}

test("transcribe posts multipart with auth and extensions", async () => {
  const { f, calls } = fakeFetch(() => Response.json({ text: "hello" }));
  const text = await createSttClient(cfg, f).transcribe(audio, "audio/webm", "clip.webm", opts);
  assert.equal(text, "hello");
  assert.equal(calls[0].url, "https://stt.example/v1/audio/transcriptions");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer k");
  const body = calls[0].init.body as FormData;
  assert.equal(body.get("model"), "parakeet-tdt-0.6b-v2");
  assert.equal(body.get("custom_words"), '["tmux"]');
  assert.equal(body.get("remove_fillers"), "true");
  assert.equal((body.get("file") as File).type, "audio/webm");
});

test("not configured when serverUrl empty", async () => {
  const { f } = fakeFetch(() => Response.json({}));
  await assert.rejects(createSttClient({ serverUrl: "", apiKey: "" }, f).transcribe(audio, "a", "b", opts), (e: SttError) => e.code === "not_configured");
});

for (const [status, code] of [[401, "unauthorized"], [400, "bad_request"], [413, "bad_request"], [503, "unavailable"], [500, "server_error"]] as const) {
  test(`HTTP ${status} -> ${code}, message from error body`, async () => {
    const { f } = fakeFetch(() => Response.json({ error: { message: `m${status}`, type: "x", code: "y" } }, { status }));
    await assert.rejects(createSttClient(cfg, f).transcribe(audio, "a", "b", opts), (e: SttError) => e.code === code && e.status === status && e.message.includes(`m${status}`));
  });
}

test("network failure -> unreachable", async () => {
  const f = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(createSttClient(cfg, f).transcribe(audio, "a", "b", opts), (e: SttError) => e.code === "unreachable");
});

test("timeout -> timeout", async () => {
  const f = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
  await assert.rejects(createSttClient(cfg, f).transcribe(audio, "a", "b", { ...opts, timeoutMs: 20 }), (e: SttError) => e.code === "timeout");
});

test("missing text -> invalid_response", async () => {
  const { f } = fakeFetch(() => Response.json({ nope: 1 }));
  await assert.rejects(createSttClient(cfg, f).transcribe(audio, "a", "b", opts), (e: SttError) => e.code === "invalid_response");
});

test("empty text is a valid result", async () => {
  const { f } = fakeFetch(() => Response.json({ text: "" }));
  assert.equal(await createSttClient(cfg, f).transcribe(audio, "a", "b", opts), "");
});

test("health hits /health", async () => {
  const { f, calls } = fakeFetch(() => Response.json({ status: "ok", version: "0.1.0", model: "parakeet-tdt-0.6b-v2", ready: true, uptime_s: 3 }));
  const h = await createSttClient(cfg, f).health();
  assert.equal(h.ready, true);
  assert.equal(calls[0].url, "https://stt.example/health");
});

const loadingBody = { status: "loading", version: "0.2.0", model: "parakeet-tdt-0.6b-v2", ready: false, uptime_s: 1 };

test("health recognises the server's 503 loading body as a not-ready result", async () => {
  const { f } = fakeFetch(() => Response.json(loadingBody, { status: 503 }));
  const h = await createSttClient(cfg, f).health();
  assert.deepEqual([h.ready, h.model, h.version], [false, "parakeet-tdt-0.6b-v2", "0.2.0"]);
});

test("health still fails for any other 503", async () => {
  for (const body of [{ error: { message: "busy" } }, { ready: true, model: "m", version: "1" }, { ready: false }, "nope", null]) {
    const { f } = fakeFetch(() => Response.json(body, { status: 503 }));
    await assert.rejects(createSttClient(cfg, f).health(), (e: SttError) => e.code === "unavailable" && e.status === 503, JSON.stringify(body));
  }
});

test("a signal that is already aborted never reaches fetch", async () => {
  const { f, calls } = fakeFetch(() => Response.json({ text: "x" }));
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(createSttClient(cfg, f).transcribe(audio, "a", "b", { ...opts, signal: ctl.signal }), (e: SttError) => e.code === "unreachable");
  assert.equal(calls.length, 0);
});

/** A response whose headers arrive at once and whose body only ends when `init.signal` aborts. */
const stalledBody = (init: RequestInit) => ({
  ok: true, status: 200,
  json: () => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
}) as unknown as Response;

test("the timeout still applies while the response body stalls", async () => {
  const f = (async (_u: string, init: RequestInit) => stalledBody(init)) as unknown as typeof fetch;
  await assert.rejects(createSttClient(cfg, f).transcribe(audio, "a", "b", { ...opts, timeoutMs: 20 }), (e: SttError) => e.code === "timeout");
  await assert.rejects(createSttClient(cfg, f).health(20), (e: SttError) => e.code === "timeout");
});

test("the caller's abort cancels a stalled body", async () => {
  const f = (async (_u: string, init: RequestInit) => stalledBody(init)) as unknown as typeof fetch;
  const ctl = new AbortController();
  const pending = createSttClient(cfg, f).transcribe(audio, "a", "b", { ...opts, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(pending, (e: SttError) => e.code === "unreachable");
});
