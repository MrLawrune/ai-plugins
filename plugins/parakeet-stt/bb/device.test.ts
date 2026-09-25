import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_ID_KEY, deviceKind, guessDeviceName, readDeviceId } from "./device.ts";

const PIXEL = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
const TAB = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

test("touch screen or desktop", () => {
  assert.equal(deviceKind(PIXEL, 5, true), "touch");
  assert.equal(deviceKind(TAB, 5, true), "touch");
  assert.equal(deviceKind(IPAD, 5, true), "touch");
  assert.equal(deviceKind(IPAD, 0, false), "desktop"); // a real Mac
  assert.equal(deviceKind(LINUX, 0, false), "desktop");
  assert.equal(deviceKind(LINUX, 10, false), "desktop"); // touchscreen laptop driven by a trackpad
  assert.equal(deviceKind(LINUX, 10, true), "touch"); // tablet asking for the desktop site
});

test("guessed names", () => {
  assert.equal(guessDeviceName(PIXEL, 5), "Android phone");
  assert.equal(guessDeviceName(TAB, 5), "Android tablet");
  assert.equal(guessDeviceName(IPAD, 5), "iPad");
  assert.equal(guessDeviceName(LINUX, 0), "Linux PC");
});

test("device id is generated once and kept", () => {
  const m = new Map<string, string>();
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(readDeviceId(s, () => "abc"), "abc");
  assert.equal(readDeviceId(s, () => "other"), "abc");
  m.set(DEVICE_ID_KEY, "bad id!");
  assert.equal(readDeviceId(s, () => "fresh"), "fresh");
});
