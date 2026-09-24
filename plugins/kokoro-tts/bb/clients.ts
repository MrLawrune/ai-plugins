// Live BB windows that can play audio, and the rules that pick a target.
import type { PlayOn, PublicClientInfo } from "./schemas.ts";

export interface ClientInfo extends PublicClientInfo {
  lastSeen: number;
}

export class ClientRegistry {
  #clients = new Map<string, ClientInfo>();
  #now: () => number;
  #ttlMs: number;

  constructor(now: () => number = Date.now, ttlMs = 150_000) {
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  upsert(info: PublicClientInfo): void {
    this.#clients.set(info.clientId, { ...info, lastSeen: this.#now() });
  }

  update(clientId: string, patch: Partial<Omit<PublicClientInfo, "clientId">>): void {
    const current = this.#clients.get(clientId);
    if (current) this.#clients.set(clientId, { ...current, ...patch, lastSeen: this.#now() });
  }

  /** Whether the client is still registered (not removed or pruned by live()). */
  has(clientId: string): boolean {
    return this.#clients.has(clientId);
  }

  remove(clientId: string): void {
    this.#clients.delete(clientId);
  }

  /** Live windows, most recently focused first. Prunes expired ones. */
  live(): ClientInfo[] {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [id, c] of this.#clients) if (c.lastSeen < cutoff) this.#clients.delete(id);
    return [...this.#clients.values()].sort((a, b) => b.focusedAt - a.focusedAt);
  }

  select(rule: PlayOn, pinnedDevice: string | null, exclude: ReadonlySet<string> = new Set()): string[] {
    const ready = this.live().filter((c) => c.audioUnlocked && !exclude.has(c.clientId));
    if (rule === "all") return ready.map((c) => c.clientId);
    if (rule === "pinned" && pinnedDevice) {
      const pinned = ready.find((c) => c.deviceName === pinnedDevice);
      if (pinned) return [pinned.clientId];
    }
    return ready.length ? [ready[0].clientId] : [];
  }
}
