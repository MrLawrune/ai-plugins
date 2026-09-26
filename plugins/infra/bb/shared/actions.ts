// Action vocabulary shared by backend and frontend. No Node or zod imports: the browser bundle loads this.
export const GUEST_ACTIONS = [
  "start", "shutdown", "reboot", "stop", "reset", "suspend", "resume",
  "snapshot.create", "snapshot.rollback", "snapshot.delete",
  "protect", "unprotect",
] as const;
export type ActionKind = (typeof GUEST_ACTIONS)[number];

/** Proxmox offers these for VMs only (LXC suspend is experimental and not offered). */
export const QEMU_ONLY_ACTIONS: readonly ActionKind[] = ["reset", "suspend", "resume"];

export interface ActionParams { snapname?: string; description?: string; vmstate?: boolean }
export type Confirm = "none" | "dialog" | "typed";
export type ActionStatus = "rejected" | "running" | "ok" | "failed" | "aborted" | "unknown";
export interface ActionSource { surface: "page" | "thread-panel"; threadId: string | null }

const RESERVED_SNAPSHOT_NAMES = new Set(["current", "vzdump"]);

/** Null when valid; otherwise a sentence for the form. Mirrors Proxmox's pve-configid format with maxLength 40. */
export function snapshotNameError(name: string): string | null {
  if (!name) return "Give the snapshot a name.";
  if (!/^[A-Za-z]/.test(name)) return "Snapshot names start with a letter.";
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) return "Use letters, digits, dashes, or underscores.";
  if (name.length < 2 || name.length > 40) return "Snapshot names are 2-40 characters.";
  if (RESERVED_SNAPSHOT_NAMES.has(name)) return `“${name}” is reserved by Proxmox.`;
  return null;
}
