import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { READY, rpcStubs } from "./fixtures.ts";

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
  await header({ status: () => ({ ...READY, muted: true }) });
  expect(await screen.findByRole("button", { name: "Unmute" })).toBeTruthy();
});

test("mute works while the engine is down", async () => {
  const slot = await header({ status: () => ({ ...READY, health: { up: false, error: "down" }, muted: true }) });
  const unmute = await screen.findByRole("button", { name: "Unmute" });
  await waitFor(() => expect(unmute.hasAttribute("disabled")).toBe(false));
  fireEvent.click(unmute);
  await waitFor(() => expect(slot.inspection.rpcCalls.find((c) => c.method === "setMuted")?.input).toEqual({ muted: false }));
});

test("controls are disabled until the plugin answers", async () => {
  await header({ status: () => { throw new Error("backend gone"); } });
  expect((await screen.findByRole("button", { name: "Stop" })).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Mute" }).hasAttribute("disabled")).toBe(true);
});
