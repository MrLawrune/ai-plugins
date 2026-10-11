import { afterEach, beforeEach, expect, test, vi } from "vitest";

const reply = { prefs: { floatingMic: false } };
const rpcWith = (call: ReturnType<typeof vi.fn>) => ({ call }) as never;

beforeEach(() => {
  vi.resetModules(); // ensureHello memoizes per module instance
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => vi.unstubAllGlobals());

test("ensureHello says hello once however many composers mount", async () => {
  const { ensureHello } = await import("./hooks.ts");
  const call = vi.fn(async () => reply);
  const rpc = rpcWith(call);
  await Promise.all([ensureHello(rpc), ensureHello(rpc), ensureHello(rpc)]);
  await ensureHello(rpc);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith("hello", expect.objectContaining({ deviceId: expect.any(String) }));
});

test("a failed hello does not poison later mounts", async () => {
  const { ensureHello } = await import("./hooks.ts");
  const call = vi.fn().mockRejectedValueOnce(new Error("server down")).mockResolvedValue(reply);
  const rpc = rpcWith(call);
  await ensureHello(rpc); // resolves even though the call failed
  await ensureHello(rpc);
  await ensureHello(rpc);
  expect(call).toHaveBeenCalledTimes(2);
});
