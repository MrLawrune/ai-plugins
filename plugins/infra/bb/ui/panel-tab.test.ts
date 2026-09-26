import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutOwnTab } from "./panel-tab.ts";

const tabs = [
  { id: "info", kind: "thread-info" },
  { id: "home", kind: "plugin-panel", pluginId: "infra", actionId: "infra", paramsJson: null, title: "Infra" },
  { id: "home-null", kind: "plugin-panel", pluginId: "infra", actionId: "infra", paramsJson: "null", title: "Infra" },
  { id: "hassist", kind: "plugin-panel", pluginId: "infra", actionId: "infra", paramsJson: "{\"target\":\"homelab/pve1/101\"}", title: "homeauto (101)" },
  { id: "proxy", kind: "plugin-panel", pluginId: "infra", actionId: "infra", paramsJson: "{\"target\":\"homelab/pve1/201\"}", title: "proxy (201)" },
  { id: "other", kind: "plugin-panel", pluginId: "other", actionId: "infra", paramsJson: null, title: "Other" },
  { id: "term", kind: "terminal", terminalId: "t1" },
];

test("closing a target tab removes only that tab", () => {
  assert.deepEqual(withoutOwnTab(tabs, "infra", "infra", { target: "homelab/pve1/101" }).map((t) => t.id), ["info", "home", "home-null", "proxy", "other", "term"]);
});

test("closing the home tab removes only home tabs (opened with or without null params)", () => {
  assert.deepEqual(withoutOwnTab(tabs, "infra", "infra", null).map((t) => t.id), ["info", "hassist", "proxy", "other", "term"]);
});
