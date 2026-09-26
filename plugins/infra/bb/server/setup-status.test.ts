import { test } from "node:test";
import assert from "node:assert/strict";
import { configurationGap } from "./setup-status.ts";

const env = { id: "e1", name: "Homelab" };
const conn = (over: Partial<{ id: string; envId: string; enabled: boolean }> = {}) => ({ id: "c1", envId: "e1", enabled: true, ...over });

test("reports what is missing, in setup order", () => {
  assert.match(configurationGap([], [], () => false)!, /Add an environment/);
  assert.match(configurationGap([env], [], () => false)!, /Add a Proxmox connection to Homelab/);
  assert.match(configurationGap([env], [conn()], () => false)!, /Save a token or password/);
  assert.match(configurationGap([env], [conn({ enabled: false })], () => true)!, /Enable/);
  assert.equal(configurationGap([env], [conn()], () => true), null);
});
