// Human-triggered guest actions: menu options, single-use approval tokens, server-side re-checks,
// the Proxmox call, and an audit row for every attempt.
import { randomUUID } from "node:crypto";
import { GUEST_ACTIONS, QEMU_ONLY_ACTIONS, type ActionKind, type ActionParams, type ActionSource, type Confirm } from "../../shared/actions.ts";
import type { Hub } from "../hub.ts";
import { PveError } from "../providers/proxmox/client.ts";
import type { CredentialKind, GuestFacts, ProviderActions, RunState } from "../providers/types.ts";
import type { Resolved } from "../service.ts";
import type { ActionRow, Store } from "../store.ts";
import { ACTION_NAMES, decide, type PolicyResult } from "./policy.ts";

export interface ActionOption { action: ActionKind; allowed: boolean; reason: string | null; confirm: Confirm | null }
export type OptionsResult = { enabled: false } | { enabled: true; options: ActionOption[]; snapshots: string[]; protected: boolean };
export type PrepareResult =
  | { allowed: false; reason: string }
  | { allowed: true; token: string; confirm: Confirm; phrase: string | null; title: string; summary: string; consequence: string };
export type ExecuteResult = { ok: false; reason: string } | { ok: true; action: ActionRow };
export interface CapabilitySummary { credential: CredentialKind; power: boolean; snapshots: boolean; rollback: boolean; protection: boolean }

export interface ActionServiceDeps {
  store: Store;
  hub: Pick<Hub, "health" | "provider">;
  resolve(target: string): Resolved | null;
  now(): number;
  onStarted(row: ActionRow): void;
  onAudit(row: ActionRow): void;
  onProtection(target: string, value: boolean): void;
  onAbortRequested(actionId: string): void;
  newToken?(): string;
}

const TOKEN_TTL_MS = 60_000;
const PRIV_TTL_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 15_000;

const CONSEQUENCE: Record<ActionKind, string> = {
  start: "The guest boots with its current configuration.",
  shutdown: "The guest is asked to shut down cleanly; Proxmox waits for it.",
  reboot: "The guest is asked to reboot cleanly.",
  stop: "The guest is stopped immediately, like pulling the power. Unsaved state is lost.",
  reset: "The VM is hard-reset immediately. Unsaved state is lost.",
  suspend: "The VM is paused in memory until you resume it.",
  resume: "The VM continues from where it was paused.",
  "snapshot.create": "A snapshot of the guest's current disks (and RAM, if chosen) is taken.",
  "snapshot.rollback": "The guest returns to this snapshot. Every change since it was taken is lost.",
  "snapshot.delete": "The snapshot is deleted. You can no longer roll back to it.",
  protect: "Proxmox will refuse to destroy this guest or remove its disks until it is unprotected.",
  unprotect: "Proxmox will allow this guest and its disks to be destroyed again.",
};

type GuestResolved = Extract<Resolved, { kind: "guest" }>;
interface Pending { target: string; action: ActionKind; params: ActionParams; source: ActionSource; stateSeen: RunState; expiresAt: number }
type Ctx = { r: GuestResolved; actions: ProviderActions; facts: GuestFacts; privileges: Set<string> | null };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ActionService {
  private readonly d: ActionServiceDeps;
  private readonly tokens = new Map<string, Pending>();
  private readonly privs = new Map<string, { at: number; set: Set<string> }>();

  constructor(deps: ActionServiceDeps) {
    this.d = deps;
  }

  private guest(target: string): GuestResolved | null {
    const r = this.d.resolve(target);
    return r && r.kind === "guest" ? r : null;
  }

  private async privileges(r: GuestResolved, actions: ProviderActions): Promise<Set<string> | null> {
    const key = `${r.guest.connectionId}/${r.guest.vmid}`;
    const hit = this.privs.get(key);
    if (hit && this.d.now() - hit.at < PRIV_TTL_MS) return hit.set;
    try {
      const set = await actions.privileges(r.ref, AbortSignal.timeout(CALL_TIMEOUT_MS));
      this.privs.set(key, { at: this.d.now(), set });
      return set;
    } catch {
      return null;
    }
  }

  clearPrivileges(connectionId?: string): void {
    for (const k of [...this.privs.keys()]) if (!connectionId || k.startsWith(`${connectionId}/`)) this.privs.delete(k);
  }

  /** Everything policy needs, or a reason the guest can't be acted on right now. */
  private async context(target: string): Promise<Ctx | { reason: string; r: GuestResolved | null }> {
    const r = this.guest(target);
    if (!r) return { reason: `${target} is not in the current inventory.`, r: null };
    const health = this.d.hub.health(r.guest.connectionId);
    if (health && health.code !== "ok") return { reason: `The connection for ${r.guest.node} is ${health.code}${health.message ? `: ${health.message}` : ""}.`, r };
    const actions = r.provider?.actions;
    if (!actions) return { reason: "This connection can't run actions.", r };
    try {
      const facts = await actions.facts(r.ref, AbortSignal.timeout(CALL_TIMEOUT_MS));
      return { r, actions, facts, privileges: await this.privileges(r, actions) };
    } catch (e) {
      if (e instanceof PveError && e.status === 403) this.clearPrivileges(r.guest.connectionId);
      return { reason: `Couldn't read ${r.guest.name || r.guest.vmid} from Proxmox: ${message(e)}`, r };
    }
  }

  private policy(c: Ctx, action: ActionKind, params: ActionParams, forMenu = false): PolicyResult {
    const g = c.r.guest;
    return decide({
      env: { kind: c.r.snap.env.kind, actionsEnabled: c.r.snap.env.actionsEnabled },
      guest: { type: g.type, state: c.facts.state, name: g.name, vmid: g.vmid, template: g.template },
      facts: c.facts, privileges: c.privileges, action, params, forMenu,
    });
  }

  private audit(r: GuestResolved, a: { action: ActionKind; params: ActionParams; source: ActionSource; confirm: Confirm | null; credential: CredentialKind },
    outcome: Pick<ActionRow, "status" | "upid" | "error"> & { endedAt: number | null }): ActionRow {
    const row = this.d.store.addAction({
      envId: r.snap.env.id, connectionId: r.guest.connectionId, target: r.target, guestName: r.guest.name,
      action: a.action, params: a.params, confirm: a.confirm, sourceSurface: a.source.surface, sourceThreadId: a.source.threadId,
      credential: a.credential, upid: outcome.upid, status: outcome.status, exitstatus: null, error: outcome.error, lastLine: null,
      requestedAt: this.d.now(), endedAt: outcome.endedAt,
    });
    this.d.onAudit(row);
    return row;
  }

  private reject(r: GuestResolved | null, a: { action: ActionKind; params: ActionParams; source: ActionSource; credential?: CredentialKind }, reason: string): { allowed: false; reason: string } {
    if (r) this.audit(r, { ...a, confirm: null, credential: a.credential ?? r.provider?.actions?.credential ?? "main" }, { status: "rejected", upid: null, error: reason, endedAt: this.d.now() });
    return { allowed: false, reason };
  }

  async options(target: string): Promise<OptionsResult | null> {
    const r = this.guest(target);
    if (!r) return null;
    if (!r.snap.env.actionsEnabled) return { enabled: false };
    const c = await this.context(target);
    const kinds = GUEST_ACTIONS.filter((a) => r.guest.type === "qemu" || !QEMU_ONLY_ACTIONS.includes(a));
    if ("reason" in c) return { enabled: true, snapshots: [], protected: false, options: kinds.map((action) => ({ action, allowed: false, reason: c.reason, confirm: null })) };
    return {
      enabled: true, snapshots: c.facts.snapshots, protected: c.facts.protected,
      options: kinds.map((action) => {
        const d = this.policy(c, action, {}, true);
        return d.allowed ? { action, allowed: true, reason: null, confirm: d.confirm } : { action, allowed: false, reason: d.reason, confirm: null };
      }),
    };
  }

  async prepare(i: { target: string; action: ActionKind; params: ActionParams; source: ActionSource }): Promise<PrepareResult> {
    const c = await this.context(i.target);
    if ("reason" in c) return this.reject(c.r, i, c.reason);
    const d = this.policy(c, i.action, i.params);
    if (!d.allowed) return this.reject(c.r, { ...i, credential: c.actions.credential }, d.reason);
    const token = this.d.newToken?.() ?? randomUUID();
    this.tokens.set(token, { target: c.r.target, action: i.action, params: i.params, source: i.source, stateSeen: c.facts.state, expiresAt: this.d.now() + TOKEN_TTL_MS });
    const who = c.r.guest.name || `${c.r.guest.type === "qemu" ? "VM" : "CT"} ${c.r.guest.vmid}`;
    const what = i.params.snapname && i.action.startsWith("snapshot.") ? ` “${i.params.snapname}”` : "";
    return {
      allowed: true, token, confirm: d.confirm, phrase: d.phrase,
      title: `${ACTION_NAMES[i.action]}${what} on ${who}?`,
      summary: `${ACTION_NAMES[i.action]}${what} · ${c.r.target} (${c.r.guest.type === "qemu" ? "VM" : "CT"} ${c.r.guest.vmid}) in ${c.r.snap.env.name}`,
      consequence: CONSEQUENCE[i.action],
    };
  }

  async execute(i: { token: string; typed?: string }): Promise<ExecuteResult> {
    const p = this.tokens.get(i.token);
    this.tokens.delete(i.token);
    if (!p || p.expiresAt < this.d.now()) return { ok: false, reason: "This confirmation expired. Start the action again." };
    const a = { action: p.action, params: p.params, source: p.source };
    const c = await this.context(p.target);
    if ("reason" in c) return { ok: false, reason: this.reject(c.r, a, c.reason).reason };
    const credential = c.actions.credential;
    const d = this.policy(c, p.action, p.params);
    if (!d.allowed) return { ok: false, reason: this.reject(c.r, { ...a, credential }, d.reason).reason };
    if (c.facts.state !== p.stateSeen) return { ok: false, reason: this.reject(c.r, { ...a, credential }, `The guest's state changed (${p.stateSeen} → ${c.facts.state}). Try again.`).reason };
    if (d.confirm === "typed" && (i.typed ?? "").trim() !== d.phrase) return { ok: false, reason: this.reject(c.r, { ...a, credential }, `Type ${d.phrase} to confirm.`).reason };

    const meta = { ...a, confirm: d.confirm, credential };
    try {
      const res = await c.actions.run(p.action, c.r.ref, p.params, AbortSignal.timeout(CALL_TIMEOUT_MS));
      if (res.kind === "done") {
        if (p.action === "protect" || p.action === "unprotect") this.d.onProtection(c.r.target, p.action === "protect");
        return { ok: true, action: this.audit(c.r, meta, { status: "ok", upid: null, error: null, endedAt: this.d.now() }) };
      }
      const row = this.audit(c.r, meta, { status: "running", upid: res.upid, error: null, endedAt: null });
      this.d.onStarted(row);
      return { ok: true, action: row };
    } catch (e) {
      if (e instanceof PveError && e.status === 403) {
        this.clearPrivileges(c.r.guest.connectionId);
        return { ok: false, reason: this.reject(c.r, { ...a, credential }, `Proxmox refused: ${e.message}`).reason };
      }
      if (e instanceof PveError && e.code === "unreachable") {
        const row = this.audit(c.r, meta, { status: "unknown", upid: null, error: `No reply from Proxmox: ${e.message}`, endedAt: null });
        this.d.onStarted(row);
        return { ok: true, action: row };
      }
      return { ok: true, action: this.audit(c.r, meta, { status: "failed", upid: null, error: message(e).slice(0, 2048), endedAt: this.d.now() }) };
    }
  }

  async abort(actionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const row = this.d.store.getAction(actionId);
    if (!row || row.status !== "running" || !row.upid) return { ok: false, reason: "That task is not running." };
    const actions = this.d.hub.provider(row.connectionId)?.actions;
    if (!actions) return { ok: false, reason: "This connection can't run actions." };
    try {
      await actions.abortTask(row.target.split("/")[1]!, row.upid, AbortSignal.timeout(CALL_TIMEOUT_MS));
      this.d.onAbortRequested(actionId);
      return { ok: true };
    } catch (e) {
      if (e instanceof PveError && e.status === 403) this.clearPrivileges(row.connectionId);
      return { ok: false, reason: `Couldn't stop the task: ${message(e)}` };
    }
  }

  async capabilities(connectionId: string): Promise<CapabilitySummary[] | null> {
    const actions = this.d.hub.provider(connectionId)?.actions;
    if (!actions) return null;
    this.clearPrivileges(connectionId);
    const creds = await actions.capabilities(AbortSignal.timeout(CALL_TIMEOUT_MS));
    return creds.map(({ credential, privileges: p }) => ({
      credential, power: p.has("VM.PowerMgmt"), snapshots: p.has("VM.Snapshot"),
      rollback: p.has("VM.Snapshot") || p.has("VM.Snapshot.Rollback"), protection: p.has("VM.Config.Options"),
    }));
  }
}
