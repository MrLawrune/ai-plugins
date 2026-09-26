// Pure presentation logic for guest actions (labels, menus, confirmation gating, progress text).
import type { ActionDto, ActionKind, CapabilitySummary, Confirm, GuestState, RunState } from "../schemas.ts";

type GuestType = GuestState["type"];

export const ACTION_LABEL: Record<ActionKind, string> = {
  start: "Start", shutdown: "Shut down", reboot: "Reboot", stop: "Stop", reset: "Reset", suspend: "Suspend", resume: "Resume",
  "snapshot.create": "Take snapshot…", "snapshot.rollback": "Roll back", "snapshot.delete": "Delete snapshot",
  protect: "Protect", unprotect: "Unprotect",
};
const ING: Record<ActionKind, string> = {
  start: "Starting", shutdown: "Shutting down", reboot: "Rebooting", stop: "Stopping", reset: "Resetting", suspend: "Suspending", resume: "Resuming",
  "snapshot.create": "Taking snapshot", "snapshot.rollback": "Rolling back", "snapshot.delete": "Deleting snapshot", protect: "Protecting", unprotect: "Unprotecting",
};
const PAST: Record<ActionKind, string> = {
  start: "Started", shutdown: "Shut down", reboot: "Rebooted", stop: "Stopped", reset: "Reset", suspend: "Suspended", resume: "Resumed",
  "snapshot.create": "Took snapshot", "snapshot.rollback": "Rolled back", "snapshot.delete": "Deleted snapshot", protect: "Protected", unprotect: "Unprotected",
};
const NOUN = Object.fromEntries(Object.entries(ACTION_LABEL).map(([k, v]) => [k, v.replace("…", "")])) as Record<ActionKind, string>;

export function primaryAction(_type: GuestType, state: RunState): ActionKind | null {
  return state === "stopped" ? "start" : state === "running" ? "shutdown" : state === "paused" ? "resume" : null;
}

export function menuActions(type: GuestType): ActionKind[] {
  const power: ActionKind[] = type === "qemu" ? ["shutdown", "reboot", "stop", "reset", "suspend", "resume"] : ["shutdown", "reboot", "stop"];
  return [...power, "snapshot.create", "protect", "unprotect"];
}

export function canSubmit(confirm: Confirm, phrase: string | null, typed: string): boolean {
  return confirm !== "typed" || (phrase !== null && typed.trim() === phrase);
}

export const isOpen = (a: ActionDto) => a.endedAt === null && (a.status === "running" || a.status === "unknown");

export function progressText(a: ActionDto): { tone: "loading" | "success" | "error" | "warning"; text: string } {
  const who = a.guestName || a.target.split("/").pop()!;
  const snap = a.params.snapname && a.action.startsWith("snapshot.") ? ` ${a.params.snapname}` : "";
  const of = a.action === "snapshot.create" ? `${snap} of ${who}` : a.action.startsWith("snapshot.") ? `${snap} on ${who}` : ` ${who}`;
  if (isOpen(a)) return { tone: "loading", text: `${ING[a.action]}${of}…${a.status === "unknown" ? " (waiting for Proxmox)" : ""}` };
  if (a.status === "ok") return { tone: "success", text: `${PAST[a.action]}${of}` };
  if (a.status === "aborted") return { tone: "warning", text: `${NOUN[a.action]} stopped on ${who}` };
  if (a.status === "unknown") return { tone: "warning", text: `${NOUN[a.action]} on ${who}: outcome unknown; check Proxmox tasks` };
  return { tone: "error", text: `${NOUN[a.action]} failed on ${who}: ${a.exitstatus ?? a.error?.split("\n").at(-1) ?? "error"}` };
}

export function capabilityText(c: CapabilitySummary): string {
  const marks = ([["Power", c.power], ["Snapshots", c.snapshots], ["Rollback", c.rollback], ["Protection", c.protection]] as const).map(([k, v]) => `${k} ${v ? "✓" : "✗"}`);
  return `${c.credential === "main" ? "Main" : "Action"} credential: ${marks.join(" · ")}`;
}
