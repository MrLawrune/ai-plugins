// Tap vs press-and-hold on one button: a press held for holdMs becomes push-to-talk until release.
export function createPressDetector(o: {
  holdMs: number;
  onTap(): void;
  onHoldStart(): void;
  onHoldEnd(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}) {
  let timer: unknown = null;
  let holding = false;
  return {
    down() {
      if (timer !== null || holding) return;
      timer = o.setTimer(() => { timer = null; holding = true; o.onHoldStart(); }, o.holdMs);
    },
    up() {
      if (holding) { holding = false; o.onHoldEnd(); return; }
      if (timer !== null) { o.clearTimer(timer); timer = null; o.onTap(); }
    },
    cancel() {
      if (holding) { holding = false; o.onHoldEnd(); return; }
      if (timer !== null) { o.clearTimer(timer); timer = null; }
    },
  };
}
