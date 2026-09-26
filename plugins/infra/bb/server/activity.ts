// Turns agent commandExecution events into per-target activity rows, tracks commands still
// running, and links inventory changes to the thread that most likely caused them.
import type { ChangeEvent } from "./hub.ts";
import { matchCommand, type MatchIndex } from "./matcher.ts";
import type { Store } from "./store.ts";

export interface RawEvent {
  seq: number;
  type: string;
  createdAt: number;
  threadId: string;
  scope?: { kind: string; turnId?: string };
  data?: { item?: { type?: string; id?: string; command?: string; exitCode?: number; status?: string } };
}

export interface EventsSdk {
  list(args: { threadId: string; afterSeq?: string; limit?: string; types?: readonly [string, ...string[]] }): Promise<RawEvent[]>;
}

export interface ActivityDeps {
  store: Store;
  events: EventsSdk;
  index(): MatchIndex;
  envIdForSlug(slug: string): string | null;
  now(): number;
  onActivity(threadIds: string[]): void;
}

const PAGE = 100; // BB rejects larger thread-event pages
const MAX_PAGES = 10;
const COMMAND_MAX = 500;
const CORRELATE_WINDOW_MS = 120_000;
const TYPES = ["item/started", "item/completed"] as const;

const hostOf = (target: string) => target.split("/").slice(0, 2).join("/");

export class Activity {
  private readonly deps: ActivityDeps;
  private readonly live = new Map<string, Map<string, string[]>>(); // threadId → itemId → targets
  private readonly chains = new Map<string, Promise<void>>();

  constructor(deps: ActivityDeps) {
    this.deps = deps;
  }

  /** Pull new events for one thread; calls for the same thread run one at a time. */
  onThreadEvents(threadId: string): Promise<void> {
    const prev = this.chains.get(threadId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.pull(threadId));
    this.chains.set(threadId, next);
    void next.finally(() => { if (this.chains.get(threadId) === next) this.chains.delete(threadId); }).catch(() => undefined);
    return next;
  }

  private async pull(threadId: string): Promise<void> {
    let changed = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const cursor = this.deps.store.getCursor(threadId);
      const events = await this.deps.events.list({ threadId, afterSeq: String(cursor), limit: String(PAGE), types: TYPES });
      if (!events.length) break;
      for (const e of events) changed = this.process(threadId, e) || changed;
      this.deps.store.setCursor(threadId, Math.max(cursor, ...events.map((e) => e.seq)));
      if (events.length < PAGE) break;
    }
    if (changed) this.deps.onActivity([threadId]);
  }

  private process(threadId: string, e: RawEvent): boolean {
    const item = e.data?.item;
    if (item?.type !== "commandExecution" || typeof item.command !== "string" || !item.id) return false;
    const targets = matchCommand(item.command, this.deps.index());
    const running = this.live.get(threadId) ?? new Map<string, string[]>();
    const phase = e.type === "item/started" ? "started" : "completed";
    const wasRunning = running.delete(item.id);
    if (phase === "started" && targets.length) running.set(item.id, targets);
    if (running.size) this.live.set(threadId, running); else this.live.delete(threadId);
    let recorded = false;
    for (const target of targets) {
      const envId = this.deps.envIdForSlug(target.split("/")[0]!);
      if (!envId) continue;
      this.deps.store.addActivity({
        envId, target, threadId, turnId: e.scope?.turnId ?? "", itemId: item.id, command: item.command.slice(0, COMMAND_MAX),
        phase, exitCode: typeof item.exitCode === "number" ? item.exitCode : null, at: e.createdAt,
      });
      recorded = true;
    }
    return recorded || wasRunning;
  }

  /** Drop in-flight commands for a thread that went idle, failed, or was stopped without completing them. */
  clearRunning(threadId: string): boolean {
    return this.live.delete(threadId);
  }

  running(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [threadId, items] of this.live) out.set(threadId, [...new Set([...items.values()].flat())].sort());
    return out;
  }

  threadsTouching(target: string, sinceMs: number): string[] {
    const rows = this.deps.store.activityFor({ targetPrefix: target, since: this.deps.now() - sinceMs, limit: 500 });
    return [...new Set(rows.map((r) => r.threadId))];
  }

  correlate(events: ChangeEvent[]): ChangeEvent[] {
    return events.map((e) => {
      if (e.threadId) return e;
      const host = hostOf(e.target);
      const hit = this.deps.store
        .activityFor({ envId: e.envId, since: e.at - CORRELATE_WINDOW_MS, limit: 200 })
        .find((a) => a.at <= e.at + CORRELATE_WINDOW_MS && (a.target === e.target || a.target === host));
      if (!hit) return e;
      if (e.id !== undefined) this.deps.store.linkChange(e.id, hit.threadId);
      return { ...e, threadId: hit.threadId };
    });
  }
}
