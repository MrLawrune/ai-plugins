import { afterEach, expect, test, vi } from "vitest";
import { mountPlayer } from "./script.ts";

type Sent = { type: string; audioUnlocked?: boolean };

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  sent: Sent[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Sent);
  }
  close() {}
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

class FakeAudio {
  static last: FakeAudio;
  state = "suspended";
  constructor() {
    FakeAudio.last = this;
  }
  async resume() {
    this.state = "running";
  }
  async close() {}
}

const abort = new AbortController();
afterEach(() => {
  abort.abort();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeSocket.all = [];
});

async function tap() {
  window.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(0);
}

test("a window whose audio the browser suspended reports the unlock again after it reconnects", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeAudio);
  const unmount = mountPlayer({ pluginId: "kokoro-tts", signal: abort.signal });

  const first = FakeSocket.all[0];
  first.open();
  await tap();
  expect(first.sent.map((m) => m.type)).toContain("unlocked");

  // A phone sleeps: the browser suspends its audio and the socket drops.
  FakeAudio.last.state = "suspended";
  first.drop();
  await vi.advanceTimersByTimeAsync(1_000);
  const second = FakeSocket.all[1];
  second.open();
  expect(second.sent[0]).toMatchObject({ type: "hello", audioUnlocked: false });

  await tap();
  expect(second.sent.map((m) => m.type)).toContain("unlocked");
  unmount();
});
