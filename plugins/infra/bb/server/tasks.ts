// Follows Proxmox tasks started from BB until they end: status, last log line, outcome, inventory refresh.
// Open rows live in the store, so tracking resumes after a plugin reload.
import type { ActionKind } from "../shared/actions.ts";
import type { InfraProvider } from "./providers/types.ts";
import type { ActionRow, Store } from "./store.ts";

export interface TrackerDeps {
  store: Store;
  providerFor(connectionId: string): InfraProvider | null;
  now(): number;
  onUpdate(row: ActionRow): void;
  onFinished(row: ActionRow): void;
  log(msg: string): void;
}

/** Proxmox worker types per action (container, VM). `suspend` without todisk runs as qmpause. */
export const TASK_TYPES: Record<Exclude<ActionKind, "protect" | "unprotect">, readonly string[]> = {
  start: ["vzstart", "qmstart"], shutdown: ["vzshutdown", "qmshutdown"], reboot: ["vzreboot", "qmreboot"], stop: ["vzstop", "qmstop"],
  reset: ["qmreset"], suspend: ["qmpause"], resume: ["qmresume"],
  "snapshot.create": ["vzsnapshot", "qmsnapshot"], "snapshot.rollback": ["vzrollback", "qmrollback"], "snapshot.delete": ["vzdelsnapshot", "qmdelsnapshot"],
};

const POLL_MS = 2000;
const GIVE_UP_MS = 24 * 3_600_000;
const RECONCILE_WINDOW_S = 30;
const LOG_PAGE = 500;
const LAST_LINE_MAX = 200;
const ERROR_MAX = 2048;
const TAIL_LINES = 20;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class Tracker {
  private readonly d: TrackerDeps;
  private readonly offsets = new Map<string, number>();
  private readonly tails = new Map<string, string[]>();
  private readonly aborting = new Set<string>();

  constructor(deps: TrackerDeps) {
    this.d = deps;
  }

  markAborting(actionId: string): void {
    this.aborting.add(actionId);
  }

  private finish(row: ActionRow, patch: Partial<ActionRow>): void {
    const done = this.d.store.updateAction(row.id, { ...patch, endedAt: this.d.now() });
    this.offsets.delete(row.id);
    this.tails.delete(row.id);
    this.aborting.delete(row.id);
    if (!done) return;
    this.d.onUpdate(done);
    this.d.onFinished(done);
  }

  private async reconcile(row: ActionRow, provider: InfraProvider, node: string, signal: AbortSignal): Promise<string | null> {
    const types = TASK_TYPES[row.action as keyof typeof TASK_TYPES];
    if (!types) return null;
    const vmid = Number(row.target.split("/")[2]);
    // tasks() only reads node and vmid from a guest ref; the type is irrelevant here.
    const tasks = await provider.tasks({ kind: "guest", node, vmid, type: "qemu" }, 20, signal);
    const at = row.requestedAt / 1000;
    return tasks.find((t) => types.includes(t.type) && Math.abs(t.start - at) <= RECONCILE_WINDOW_S)?.upid ?? null;
  }

  async pollOnce(signal: AbortSignal): Promise<void> {
    for (let row of this.d.store.openActions()) {
      if (signal.aborted) return;
      if (this.d.now() - row.requestedAt > GIVE_UP_MS) {
        this.finish(row, { status: "unknown", error: row.error ?? "Outcome unknown after 24 hours; check the Proxmox task list." });
        continue;
      }
      const provider = this.d.providerFor(row.connectionId);
      const actions = provider?.actions;
      if (!provider || !actions) continue;
      const node = row.target.split("/")[1]!;
      try {
        if (!row.upid) {
          const upid = await this.reconcile(row, provider, node, signal);
          if (!upid) continue;
          row = this.d.store.updateAction(row.id, { upid, status: "running", error: null }) ?? row;
          this.d.onUpdate(row);
        }
        const upid = row.upid!;
        const st = await actions.taskStatus(node, upid, signal);
        const offset = this.offsets.get(row.id) ?? 0;
        const lines = await actions.taskLog(node, upid, offset, LOG_PAGE, signal).catch(() => [] as string[]);
        this.offsets.set(row.id, offset + lines.length);
        const tail = [...(this.tails.get(row.id) ?? []), ...lines].slice(-TAIL_LINES);
        this.tails.set(row.id, tail);
        const lastLine = lines.length ? lines.at(-1)!.slice(0, LAST_LINE_MAX) : row.lastLine;
        if (st.running) {
          if (lastLine !== row.lastLine) {
            const upd = this.d.store.updateAction(row.id, { lastLine });
            if (upd) this.d.onUpdate(upd);
          }
          continue;
        }
        const ok = st.exitstatus === "OK";
        this.finish(row, {
          status: ok ? "ok" : this.aborting.has(row.id) ? "aborted" : "failed",
          exitstatus: st.exitstatus, lastLine,
          error: ok ? null : (tail.join("\n") || st.exitstatus || "task failed").slice(-ERROR_MAX),
        });
      } catch (e) {
        this.d.log(`tracking ${row.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.pollOnce(signal).catch((e: unknown) => this.d.log(`task poll failed: ${String(e)}`));
      await sleep(POLL_MS, signal);
    }
  }
}
