/** Start times for gapless back-to-back PCM buffers on an AudioContext clock. */
export class PcmScheduler {
  #end = 0;
  #lead: number;

  constructor(leadS = 0.05) {
    this.#lead = leadS;
  }

  next(now: number, duration: number): number {
    const start = Math.max(now + this.#lead, this.#end);
    this.#end = start + duration;
    return start;
  }

  get end(): number {
    return this.#end;
  }
}
