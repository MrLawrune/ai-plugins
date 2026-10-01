/** A Map capped at `max` entries; reads and writes refresh recency, the least recently used is evicted. */
export class LruMap<K, V> {
  #max: number;
  #map = new Map<K, V>();

  constructor(max: number) {
    this.#max = max;
  }

  get(k: K): V | undefined {
    if (!this.#map.has(k)) return undefined;
    const v = this.#map.get(k) as V;
    this.#map.delete(k);
    this.#map.set(k, v);
    return v;
  }

  set(k: K, v: V): void {
    this.#map.delete(k);
    this.#map.set(k, v);
    if (this.#map.size > this.#max) this.#map.delete(this.#map.keys().next().value as K);
  }

  delete(k: K): boolean {
    return this.#map.delete(k);
  }

  has(k: K): boolean {
    return this.#map.has(k);
  }

  get size(): number {
    return this.#map.size;
  }
}

/** A Set capped at `max` members; adding refreshes recency, the least recently added is evicted. */
export class LruSet<K> {
  #map: LruMap<K, true>;

  constructor(max: number) {
    this.#map = new LruMap(max);
  }

  add(k: K): void {
    this.#map.set(k, true);
  }

  has(k: K): boolean {
    return this.#map.has(k);
  }

  delete(k: K): boolean {
    return this.#map.delete(k);
  }

  get size(): number {
    return this.#map.size;
  }
}
