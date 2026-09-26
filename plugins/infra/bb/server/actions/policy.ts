// Pure action policy: is this action allowed on this guest now, and how must a human confirm it?
// The server runs it in prepare and again in execute; the UI only displays its answers.
import { QEMU_ONLY_ACTIONS, snapshotNameError, type ActionKind, type ActionParams, type Confirm } from "../../shared/actions.ts";
import type { EnvKind } from "../../shared/constants.ts";
import type { GuestType, RunState } from "../providers/types.ts";

export interface PolicyInput {
  env: { kind: EnvKind; actionsEnabled: boolean };
  guest: { type: GuestType; state: RunState; name: string; vmid: number; template: boolean };
  facts: { protected: boolean; snapshots: string[] };
  privileges: ReadonlySet<string> | null;
  action: ActionKind;
  params: ActionParams;
  /** Menu mode: skip checks that depend on parameters the user hasn't chosen yet (snapshot name). */
  forMenu?: boolean;
}
export type PolicyResult = { allowed: true; confirm: Confirm; phrase: string | null } | { allowed: false; reason: string };

export const ACTION_NAMES: Record<ActionKind, string> = {
  start: "Start", shutdown: "Shut down", reboot: "Reboot", stop: "Stop", reset: "Reset", suspend: "Suspend", resume: "Resume",
  "snapshot.create": "Take snapshot", "snapshot.rollback": "Roll back snapshot", "snapshot.delete": "Delete snapshot",
  protect: "Protect", unprotect: "Unprotect",
};

/** Any one privilege in the list suffices (rollback accepts either snapshot privilege). */
export const REQUIRED_PRIVILEGES: Record<ActionKind, readonly string[]> = {
  start: ["VM.PowerMgmt"], shutdown: ["VM.PowerMgmt"], reboot: ["VM.PowerMgmt"], stop: ["VM.PowerMgmt"],
  reset: ["VM.PowerMgmt"], suspend: ["VM.PowerMgmt"], resume: ["VM.PowerMgmt"],
  "snapshot.create": ["VM.Snapshot"], "snapshot.rollback": ["VM.Snapshot", "VM.Snapshot.Rollback"], "snapshot.delete": ["VM.Snapshot"],
  protect: ["VM.Config.Options"], unprotect: ["VM.Config.Options"],
};

const NEEDS_STATE: Partial<Record<ActionKind, RunState>> = {
  start: "stopped", shutdown: "running", reboot: "running", stop: "running", reset: "running", suspend: "running", resume: "paused",
};
const TYPED_ALWAYS: ReadonlySet<ActionKind> = new Set(["unprotect", "snapshot.rollback"]);
const DIALOG: ReadonlySet<ActionKind> = new Set(["shutdown", "reboot", "stop", "reset", "suspend", "snapshot.delete"]);

const no = (reason: string): PolicyResult => ({ allowed: false, reason });

export function decide(i: PolicyInput): PolicyResult {
  const { action, guest: g } = i;
  const who = g.name || `${g.type === "qemu" ? "VM" : "CT"} ${g.vmid}`;
  if (!i.env.actionsEnabled) return no("Actions are off for this environment. Turn them on in Settings → Environments.");
  if (g.template) return no("Templates can't be started or changed from BB.");
  if (QEMU_ONLY_ACTIONS.includes(action) && g.type !== "qemu") return no(`${ACTION_NAMES[action]} is only available for VMs.`);
  if (!i.privileges) return no("Couldn't read the credential's privileges. Test the connection in Settings.");
  const req = REQUIRED_PRIVILEGES[action];
  if (!req.some((p) => i.privileges!.has(p))) return no(`The credential lacks ${req.join(" or ")} on /vms/${g.vmid}.`);
  const need = NEEDS_STATE[action];
  if (need && g.state !== need) return no(`${who} is ${g.state}; ${ACTION_NAMES[action].toLowerCase()} needs it ${need}.`);

  if (action === "protect" && i.facts.protected) return no(`${who} is already protected.`);
  if (action === "unprotect" && !i.facts.protected) return no(`${who} is not protected.`);
  if (action === "snapshot.create" && !i.forMenu) {
    const name = i.params.snapname ?? "";
    const bad = snapshotNameError(name);
    if (bad) return no(bad);
    if (i.facts.snapshots.includes(name)) return no(`A snapshot named “${name}” already exists.`);
    if (i.params.vmstate && (g.type !== "qemu" || g.state !== "running")) return no("Including RAM needs a running VM.");
  }
  if (action === "snapshot.rollback" || action === "snapshot.delete") {
    if (!i.facts.snapshots.length) return no(`${who} has no snapshots.`);
    if (!i.forMenu) {
      if (!i.params.snapname) return no("Pick a snapshot.");
      if (!i.facts.snapshots.includes(i.params.snapname)) return no(`Snapshot “${i.params.snapname}” no longer exists.`);
    }
  }

  if (i.env.kind === "prod" || TYPED_ALWAYS.has(action)) return { allowed: true, confirm: "typed", phrase: g.name || String(g.vmid) };
  return { allowed: true, confirm: DIALOG.has(action) ? "dialog" : "none", phrase: null };
}
