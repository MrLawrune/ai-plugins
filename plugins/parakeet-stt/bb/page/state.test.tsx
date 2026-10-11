import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DOWN, UP } from "./fixtures.ts";
import { refreshHealth, useHealth } from "./state.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function Probe({ id }: { id: string }) {
  const h = useHealth();
  return <p data-testid={id}>{h ? (h.up ? "up" : "down") : "none"}</p>;
}
function Two() {
  return <><Probe id="a" /><Probe id="b" /></>;
}

const healthCalls = (view: ReturnType<typeof renderSlot>) => view.inspection.rpcCalls.filter((c) => c.method === "health").length;
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

test("a mounted consumer loads health at once and polls every 5 s, never faster", async () => {
  const view = renderSlot({ component: Probe }, { id: "a" }, { rpc: { health: () => UP } });
  await tick(0);
  expect(view.getByTestId("a").textContent).toBe("up");
  expect(healthCalls(view)).toBe(1);
  await tick(4_999);
  expect(healthCalls(view)).toBe(1);
  await tick(1);
  expect(healthCalls(view)).toBe(2);
  await tick(5_000);
  expect(healthCalls(view)).toBe(3);
});

test("two mounted consumers share one interval and one call per tick", async () => {
  const view = renderSlot({ component: Two }, {}, { rpc: { health: () => UP } });
  await tick(0);
  expect(vi.getTimerCount()).toBe(1);
  expect(view.getByTestId("a").textContent).toBe("up");
  expect(view.getByTestId("b").textContent).toBe("up");
  expect(healthCalls(view)).toBe(1);
  await tick(5_000);
  expect(healthCalls(view)).toBe(2);
});

test("the poll stops completely when the last consumer unmounts", async () => {
  const view = renderSlot({ component: Two }, {}, { rpc: { health: () => UP } });
  await tick(0);
  const before = healthCalls(view);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  await tick(60_000);
  expect(healthCalls(view)).toBe(before);
});

test("a consumer that mounts after others unmounted restarts the poll, with one check at most every 5 s", async () => {
  const first = renderSlot({ component: Probe }, { id: "a" }, { rpc: { health: () => UP } });
  await tick(0);
  first.unmount();
  expect(vi.getTimerCount()).toBe(0);
  // Remounted straight away: the last result is still fresh, so no immediate call.
  const quick = renderSlot({ component: Probe }, { id: "a" }, { rpc: { health: () => UP } });
  await tick(0);
  expect(vi.getTimerCount()).toBe(1);
  expect(quick.getByTestId("a").textContent).toBe("up");
  expect(healthCalls(quick)).toBe(0);
  await tick(5_000);
  expect(healthCalls(quick)).toBe(1);
  quick.unmount();
  // Remounted after the result went stale: check at once.
  await tick(5_000);
  const late = renderSlot({ component: Probe }, { id: "a" }, { rpc: { health: () => UP } });
  await tick(0);
  expect(healthCalls(late)).toBe(1);
});

test("a consumer mounting while a check is in flight still gets its result", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const rpc = { health: async () => { await gate; return UP; } };
  const a = renderSlot({ component: Probe }, { id: "a" }, { rpc });
  await tick(0);
  const b = renderSlot({ component: Probe }, { id: "b" }, { rpc });
  release();
  await tick(0);
  expect(a.getByTestId("a").textContent).toBe("up");
  expect(b.getByTestId("b").textContent).toBe("up");
});

test("a consumer that renders just before a result lands is not left on the old value", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const rpc = { health: async () => { await gate; return UP; } };
  const a = renderSlot({ component: Probe }, { id: "a" }, { rpc });
  await tick(0);
  release();
  await tick(0);
  // Mounted after the result: initial state and subscription both see it.
  const b = renderSlot({ component: Probe }, { id: "b" }, { rpc });
  expect(b.getByTestId("b").textContent).toBe("up");
  expect(a.getByTestId("a").textContent).toBe("up");
});

test("refreshHealth during a poll in flight runs one more check after it", async () => {
  const results = [DOWN, UP];
  const resolvers: (() => void)[] = [];
  let n = 0;
  const view = renderSlot({ component: Probe }, { id: "a" }, {
    rpc: { health: () => new Promise((r) => { const v = results[n++]!; resolvers.push(() => r(v)); }) },
  });
  await tick(0);
  expect(n).toBe(1);
  let done = false;
  void refreshHealth().then(() => { done = true; });
  await tick(0);
  expect(n).toBe(1);
  await act(async () => { resolvers[0]!(); });
  await tick(0);
  expect(n).toBe(2);
  expect(done).toBe(false);
  await act(async () => { resolvers[1]!(); });
  await tick(0);
  expect(done).toBe(true);
  expect(view.getByTestId("a").textContent).toBe("up");
});

test("refreshHealth forces one call now without a second timer", async () => {
  const view = renderSlot({ component: Probe }, { id: "a" }, { rpc: { health: () => UP } });
  await tick(0);
  await act(async () => { await refreshHealth(); });
  expect(healthCalls(view)).toBe(2);
  expect(vi.getTimerCount()).toBe(1);
});

test("a failing health call reads as unreachable with the error", async () => {
  let fail = false;
  function Text() {
    const h = useHealth();
    return <p data-testid="t">{h ? `${h.up}|${h.error}` : "none"}</p>;
  }
  const view = renderSlot({ component: Text }, {}, { rpc: { health: () => { if (fail) throw new Error("backend gone"); return UP; } } });
  await tick(0);
  expect(view.getByTestId("t").textContent).toBe("true|null");
  fail = true;
  await tick(5_000);
  expect(view.getByTestId("t").textContent).toBe("false|backend gone");
});
