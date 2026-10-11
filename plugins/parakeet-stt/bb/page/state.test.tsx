import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { UP } from "./fixtures.ts";
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

test("a consumer that mounts after others unmounted starts the poll again", async () => {
  const first = renderSlot({ component: Probe }, { id: "a" }, { rpc: { health: () => UP } });
  await tick(0);
  first.unmount();
  expect(vi.getTimerCount()).toBe(0);
  const second = renderSlot({ component: Probe }, { id: "a" }, { rpc: { health: () => UP } });
  await tick(0);
  expect(vi.getTimerCount()).toBe(1);
  expect(healthCalls(second)).toBe(1);
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
