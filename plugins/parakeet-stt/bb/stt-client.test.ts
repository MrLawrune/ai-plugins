import { test } from "node:test";
import assert from "node:assert/strict";
import { aiFailure, createSttClient, SttError } from "./stt-client.ts";

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

test("aiFailure maps codes", () => {
  const cases: [string, string][] = [["not_configured", "auth_required"], ["unauthorized", "auth_required"], ["unreachable", "service_unavailable"], ["unavailable", "service_unavailable"], ["server_error", "service_unavailable"], ["timeout", "timeout"], ["bad_request", "request_failed"], ["invalid_response", "invalid_response"]];
  for (const [from, to] of cases) {
    assert.equal(aiFailure(new SttError(from as never, "x", null)).code, to);
  }
  assert.equal(aiFailure(new Error("boom")).code, "service_unavailable");
});
