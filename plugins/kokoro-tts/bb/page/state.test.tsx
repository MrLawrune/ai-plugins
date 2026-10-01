import { expect, test } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { READY, rpcStubs } from "./fixtures.ts";
import { refreshStatus, useConfig, useStatus } from "./state.ts";

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

function Patcher() {
  const { data, patch } = useConfig(true);
  return (
    <button type="button" disabled={!data} onClick={() => { patch({ speed: 1.2 }, 50); patch({ intra_op_threads: 4 }, 50); }}>
      patch
    </button>
  );
}

test("speech settings and engine runtime keys are saved in separate calls", async () => {
  const view = renderSlot({ component: Patcher }, {}, { rpc: rpcStubs() });
  const button = view.getByRole("button", { name: "patch" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  await waitFor(() => {
    const calls = view.inspection.rpcCalls.filter((c) => c.method === "patchConfig").map((c) => c.input);
    expect(calls).toEqual(expect.arrayContaining([{ speed: 1.2 }, { intra_op_threads: 4 }]));
    expect(calls).toHaveLength(2);
  });
});
