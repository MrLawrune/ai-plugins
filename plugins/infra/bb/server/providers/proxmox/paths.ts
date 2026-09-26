// API paths shared by the read adapter and the action capability.
import type { GuestRef } from "../types.ts";

export const hostPath = (node: string) => `/nodes/${encodeURIComponent(node)}`;
export const guestPath = (ref: GuestRef) => `${hostPath(ref.node)}/${ref.type}/${ref.vmid}`;
export const taskPath = (node: string, upid: string) => `${hostPath(node)}/tasks/${encodeURIComponent(upid)}`;
