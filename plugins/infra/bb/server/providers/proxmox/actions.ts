// Proxmox VE guest actions: power, snapshots, protection; plus privilege and task lookups.
import type { ActionKind, ActionParams } from "../../../shared/actions.ts";
import type { ActionResult, CredentialKind, GuestFacts, GuestRef, ProviderActions, RunState, TaskStatus } from "../types.ts";
import type { PveParams } from "./client.ts";
import { guestPath, taskPath } from "./paths.ts";

export interface GetClient {
  get<T>(path: string, query?: Record<string, string | number>, signal?: AbortSignal): Promise<T>;
}
export interface WriteClient extends GetClient {
  post<T>(path: string, params?: PveParams, signal?: AbortSignal): Promise<T>;
  put<T>(path: string, params?: PveParams, signal?: AbortSignal): Promise<T>;
  delete<T>(path: string, params?: PveParams, signal?: AbortSignal): Promise<T>;
}
export const isWriteClient = (c: GetClient): c is WriteClient => typeof (c as Partial<WriteClient>).post === "function";

type Raw = Record<string, unknown>;
type PermissionMap = Record<string, Record<string, number>>;

const POWER: Partial<Record<ActionKind, string>> = { start: "start", shutdown: "shutdown", reboot: "reboot", stop: "stop", reset: "reset", suspend: "suspend", resume: "resume" };
const STATES: ReadonlySet<string> = new Set(["running", "stopped", "paused"]);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const task = (upid: string): ActionResult => ({ kind: "task", upid });

export class ProxmoxActions implements ProviderActions {
  private readonly reader: GetClient;
  private readonly writer: WriteClient;
  readonly credential: CredentialKind;

  /** `reader` is the polling credential; `writer` runs actions (the same client when there is no action credential). */
  constructor(reader: GetClient, writer: WriteClient, credential: CredentialKind) {
    this.reader = reader;
    this.writer = writer;
    this.credential = credential;
  }

  async privileges(ref: GuestRef, signal: AbortSignal): Promise<Set<string>> {
    const path = `/vms/${ref.vmid}`;
    const map = await this.writer.get<PermissionMap>("/access/permissions", { path }, signal);
    return new Set(Object.keys(map[path] ?? {}));
  }

  async capabilities(signal: AbortSignal) {
    const read = async (c: GetClient) => new Set(Object.keys((await c.get<PermissionMap>("/access/permissions", { path: "/vms" }, signal))["/vms"] ?? {}));
    const out: { credential: CredentialKind; privileges: Set<string> }[] = [{ credential: "main", privileges: await read(this.reader) }];
    if (this.writer !== this.reader) out.push({ credential: "action", privileges: await read(this.writer) });
    return out;
  }

  async facts(ref: GuestRef, signal: AbortSignal): Promise<GuestFacts> {
    const base = guestPath(ref);
    const [status, config, snaps] = await Promise.all([
      this.reader.get<Raw>(`${base}/status/current`, undefined, signal),
      this.reader.get<Raw>(`${base}/config`, undefined, signal),
      this.reader.get<Raw[]>(`${base}/snapshot`, undefined, signal).catch(() => [] as Raw[]),
    ]);
    const s = str(status.status);
    return {
      state: (STATES.has(s) ? s : "unknown") as RunState,
      protected: str(config.protection) === "1",
      snapshots: snaps.map((x) => str(x.name)).filter((n) => n && n !== "current"),
    };
  }

  async run(action: ActionKind, ref: GuestRef, params: ActionParams, signal: AbortSignal): Promise<ActionResult> {
    const base = guestPath(ref);
    const power = POWER[action];
    if (power) return task(await this.writer.post<string>(`${base}/status/${power}`, undefined, signal));
    const snap = encodeURIComponent(params.snapname ?? "");
    switch (action) {
      case "snapshot.create":
        return task(await this.writer.post<string>(`${base}/snapshot`, {
          snapname: params.snapname ?? "",
          ...(params.description ? { description: params.description } : {}),
          ...(ref.type === "qemu" && params.vmstate ? { vmstate: 1 } : {}),
        }, signal));
      case "snapshot.rollback":
        return task(await this.writer.post<string>(`${base}/snapshot/${snap}/rollback`, undefined, signal));
      case "snapshot.delete":
        return task(await this.writer.delete<string>(`${base}/snapshot/${snap}`, undefined, signal));
      case "protect":
      case "unprotect":
        await this.writer.put<null>(`${base}/config`, { protection: action === "protect" ? 1 : 0 }, signal);
        return { kind: "done" };
      default:
        throw new Error(`unsupported action ${action}`);
    }
  }

  async taskStatus(node: string, upid: string, signal: AbortSignal): Promise<TaskStatus> {
    const r = await this.writer.get<Raw>(`${taskPath(node, upid)}/status`, undefined, signal);
    return { running: str(r.status) === "running", exitstatus: str(r.exitstatus) || null };
  }

  async taskLog(node: string, upid: string, start: number, limit: number, signal: AbortSignal): Promise<string[]> {
    const rows = await this.writer.get<Raw[]>(`${taskPath(node, upid)}/log`, { start, limit }, signal);
    return rows.map((r) => str(r.t));
  }

  async abortTask(node: string, upid: string, signal: AbortSignal): Promise<void> {
    await this.writer.delete<null>(taskPath(node, upid), undefined, signal);
  }
}
