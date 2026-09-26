import { expect, test } from "vitest";
import { act } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { READY } from "./fixtures.ts";
import { refreshStatus, useStatus } from "./state.ts";

function Probe() {
  const s = useStatus();
  return <p data-testid="s">{s ? s.setup.state : "none"}</p>;
}

test("status drops to unknown after two consecutive failed polls, and recovers", async () => {
  let fail = false;
  const view = renderSlot({ component: Probe }, {}, {
    rpc: {
      status: async () => {
        if (fail) throw new Error("backend gone");
        return READY;
      },
    },
  });
  const shown = () => view.getByTestId("s").textContent;
  await act(async () => {});
  expect(shown()).toBe("running");

  fail = true;
  await act(async () => refreshStatus());
  expect(shown()).toBe("running"); // one blip keeps the last status
  await act(async () => refreshStatus());
  expect(shown()).toBe("none");

  fail = false;
  await act(async () => refreshStatus());
  expect(shown()).toBe("running");
});
