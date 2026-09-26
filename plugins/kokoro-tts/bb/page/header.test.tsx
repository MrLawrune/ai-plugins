import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { HEALTH, READY, rpcStubs } from "./fixtures.ts";

async function header(overrides = {}) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const Header = app.navPanels[0]!.headerContent!;
  return renderSlot({ component: Header }, { subPath: "" }, { rpc: rpcStubs(overrides) });
}

test("shows status and mutes", async () => {
  const slot = await header();
  expect(await screen.findByText("Ready")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mute" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "setMuted")).toBe(true));
});

test("shows Unmute while muted", async () => {
  await header({ status: () => ({ ...READY, health: { up: true, health: { ...HEALTH, muted: true } } }) });
  expect(await screen.findByRole("button", { name: "Unmute" })).toBeTruthy();
});

test("controls are disabled while the server is down", async () => {
  await header({ status: () => ({ ...READY, health: { up: false, error: "down" } }) });
  expect((await screen.findByRole("button", { name: "Stop" })).hasAttribute("disabled")).toBe(true);
});
