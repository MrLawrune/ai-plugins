// Per-thread infra scope. contributeInstructions is synchronous, so pins are served from memory.
import type { PinRow, Store } from "./store.ts";

export const INSTRUCTIONS_MAX = 4096;
export const HEADER = "Infra context pinned to this thread (read-only reference; operate through your usual tools such as ssh):";

export class Pins {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly pins = new Map<string, PinRow>();

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  load(): void {
    this.pins.clear();
    for (const p of this.store.listPins()) this.pins.set(p.threadId, p);
  }

  set(threadId: string, targets: string[], rulesIncluded: boolean): PinRow {
    const pin: PinRow = { threadId, targets: [...new Set(targets)], rulesIncluded, pinnedAt: this.now() };
    this.store.setPin(pin);
    this.pins.set(threadId, pin);
    return pin;
  }

  clear(threadId: string): void {
    this.store.deletePin(threadId);
    this.pins.delete(threadId);
  }

  /** Forget every target under an environment; a pin left without targets is removed. */
  dropEnv(slug: string): void {
    for (const pin of [...this.pins.values()]) {
      const keep = pin.targets.filter((t) => t !== slug && !t.startsWith(`${slug}/`));
      if (keep.length === pin.targets.length) continue;
      if (keep.length) this.set(pin.threadId, keep, pin.rulesIncluded);
      else this.clear(pin.threadId);
    }
  }

  get(threadId: string): PinRow | null {
    return this.pins.get(threadId) ?? null;
  }

  instructions(threadId: string | undefined, render: (pin: PinRow) => string): string | null {
    const pin = threadId ? this.pins.get(threadId) : undefined;
    if (!pin) return null;
    const text = `${HEADER}\n${render(pin)}`;
    return text.length <= INSTRUCTIONS_MAX ? text : text.slice(0, INSTRUCTIONS_MAX - 1) + "…";
  }
}
