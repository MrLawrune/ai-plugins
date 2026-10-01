import { test } from "node:test";
import assert from "node:assert/strict";
import { createKokoroEngine } from "./kokoro.ts";
import { EngineError, type Pcm, type SynthOpts } from "./types.ts";

const OPTS: SynthOpts = { voice: "af_sky", speed: 1.1, lang: "en-us", trim: true };
const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
/** v2 body: [u32le(len), bytes…] per frame, then the u32le(0) end marker. */
function v2(...frames: Uint8Array[]): Uint8Array {
  const parts = frames.flatMap((f) => [u32le(f.length), f]).concat([u32le(0)]);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const audio = (res: Uint8Array) => new Response(new Blob([res as BlobPart]).stream(), { status: 200, headers: { "X-Kokoro-Frames": "2" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
async function collect(it: AsyncIterable<Pcm>) { const out: Pcm[] = []; for await (const f of it) out.push(f); return out; }
const isKind = (kind: string, re?: RegExp) => (e: unknown) => e instanceof EngineError && e.kind === kind && (!re || re.test(e.message));
const run = (fake: typeof fetch) => collect(createKokoroEngine("http://10.0.0.5:6789", fake).synthesize("Hi.", OPTS, new AbortController().signal));

test("synthesize streams v2 frames and sends the full request", async () => {
  let url = ""; let init: RequestInit | undefined;
  const fake = (async (u: string, i?: RequestInit) => { url = u; init = i; return audio(v2(new Uint8Array(8).fill(1), new Uint8Array(4).fill(2))); }) as typeof fetch;
  const frames = await run(fake);
  assert.deepEqual(frames.map((f) => [...f]), [[1, 1, 1, 1, 1, 1, 1, 1], [2, 2, 2, 2]]);
  assert.equal(url, "http://10.0.0.5:6789/synthesize");
  assert.equal(init?.method, "POST");
  assert.deepEqual(init?.headers, { "Content-Type": "application/json", "X-Kokoro-Frames": "2", "X-Kokoro-Hop": "1" });
  assert.deepEqual(JSON.parse(String(init?.body)), { text: "Hi.", voice: "af_sky", speed: 1.1, lang: "en-us", trim: true });
  assert.ok(init?.signal);
});

test("fetch rejecting is unreachable, with the underlying cause", async () => {
  const fake = (async () => { throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 10.0.0.5:6789") }); }) as typeof fetch;
  await assert.rejects(run(fake), isKind("unreachable", /^unreachable: connect ECONNREFUSED 10\.0\.0\.5:6789$/));
});

test("HTTP 5xx is unreachable", async () => {
  await assert.rejects(run((async () => json({ error: "boom" }, 503)) as typeof fetch), isKind("unreachable", /^unreachable: /));
});

test("HTTP 400 is config with the server's error and fields", async () => {
  const fake = (async () => json({ error: "invalid parameters", fields: { voice: "unknown voice 'x'" } }, 400)) as typeof fetch;
  await assert.rejects(run(fake), isKind("config", /invalid parameters.*unknown voice 'x'/));
});

test("HTTP 409 is config: the server forwards", async () => {
  await assert.rejects(run((async () => json({ error: "remote" }, 409)) as typeof fetch),
    isKind("config", /^this server forwards to another one; point at the synthesis server directly$/));
});

test("a frame length that is not float32 is a stream error", async () => {
  const bad = new Uint8Array([...u32le(6), 0, 0, 0, 0, 0, 0, ...u32le(0)]);
  await assert.rejects(run((async () => audio(bad)) as typeof fetch), isKind("stream", /bad frame length 6/));
});

test("zero frames is a stream error", async () => {
  await assert.rejects(run((async () => audio(v2())) as typeof fetch), isKind("stream", /^the Kokoro server returned no audio$/));
});

test("an aborted request is cancelled, not unreachable", async () => {
  const ac = new AbortController(); ac.abort();
  const fake = (async () => { throw new DOMException("aborted", "AbortError"); }) as typeof fetch;
  await assert.rejects(collect(createKokoroEngine("http://10.0.0.5:6789", fake).synthesize("Hi.", OPTS, ac.signal)), isKind("cancelled"));
});

test("health maps local/remote engines", async () => {
  const local = createKokoroEngine("http://h", (async () => json({ version: "1.2", engine: { kind: "local", loaded: false } })) as typeof fetch);
  assert.deepEqual(await local.health(new AbortController().signal),
    { reachable: true, loaded: false, version: "1.2", forwards: false, error: null });
  const remote = createKokoroEngine("http://h", (async () => json({ engine: { kind: "remote" } })) as typeof fetch);
  assert.deepEqual(await remote.health(new AbortController().signal),
    { reachable: true, loaded: null, version: null, forwards: true, error: null });
});

test("health failure is unreachable with the message", async () => {
  const down = createKokoroEngine("http://h", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
  const h = await down.health(new AbortController().signal);
  assert.equal(h.reachable, false); assert.equal(h.loaded, null); assert.equal(h.forwards, null);
  assert.match(h.error ?? "", /fetch failed/);
});

test("voices parses the list", async () => {
  const v = { name: "af_sky", lang_code: "a", lang: "en-us", language: "English (US)", gender: "female" };
  let url = "";
  const e = createKokoroEngine("http://h/", (async (u: string) => { url = u; return json({ voices: [v] }); }) as typeof fetch);
  assert.deepEqual(await e.voices(new AbortController().signal), [v]);
  assert.equal(url, "http://h/voices");
});

const stalls = (async (_u: string, init?: RequestInit) => new Promise<Response>((_, rej) => {
  init?.signal?.addEventListener("abort", () => rej(init.signal?.reason));
})) as typeof fetch;

test("health reports a timeout as a timeout", async () => {
  const e = createKokoroEngine("http://h", stalls, { queryTimeoutMs: 20 });
  const h = await e.health(new AbortController().signal);
  assert.equal(h.reachable, false); assert.equal(h.error, "timed out after 20 ms");
});

test("health rethrows when the caller aborts", async () => {
  const e = createKokoroEngine("http://h", stalls, { queryTimeoutMs: 5000 });
  const ac = new AbortController(); setTimeout(() => ac.abort(), 10);
  await assert.rejects(e.health(ac.signal), isKind("cancelled"));
});
