import { cleanup } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach } from "vitest";

// The SDK binds its runtime at import time, so it is installed here and state.ts is imported lazily.
installTestPluginRuntime();

// vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => cleanup());
afterEach(async () => {
  (await import("./page/state.ts")).resetStatusForTests();
});

// jsdom lacks the layout APIs Radix controls call on mount.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};
