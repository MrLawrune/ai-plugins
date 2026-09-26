// Toasts for actions started in this window: one toast per action, updated as infra:task signals arrive.
import { toast } from "sonner";
import type { ActionDto } from "../schemas.ts";
import { isOpen, progressText } from "./actions-model.ts";

/** An action still open after this is given up on (sonner never auto-dismisses loading toasts). */
export const LOADING_BACKSTOP_MS = 10 * 60_000;

const watched = new Set<string>();
const warned = new Set<string>();
const backstops = new Map<string, ReturnType<typeof setTimeout>>();

function show(a: ActionDto): void {
  const p = progressText(a);
  const opts = { id: a.id, description: isOpen(a) ? a.lastLine ?? undefined : a.status === "failed" ? a.error?.split("\n").slice(-3).join("\n") : undefined };
  if (p.tone === "loading") toast.loading(p.text, opts);
  else if (p.tone === "success") toast.success(p.text, opts);
  else if (p.tone === "warning") toast.warning(p.text, opts);
  else toast.error(p.text, { ...opts, duration: 15_000 });
}

function unwatch(id: string): void {
  watched.delete(id);
  warned.delete(id);
  clearTimeout(backstops.get(id));
  backstops.delete(id);
}

export function watchAction(a: ActionDto): void {
  if (isOpen(a)) {
    watched.add(a.id);
    clearTimeout(backstops.get(a.id));
    backstops.set(a.id, setTimeout(() => {
      unwatch(a.id);
      toast.warning(`Still running: ${progressText(a).text.replace(/….*$/, "")}`, { id: a.id, description: "Check the Tasks tab for its outcome." });
    }, LOADING_BACKSTOP_MS));
  }
  show(a);
}

export const isWatched = (id: string) => watched.has(id);
export const watchedIds = (): string[] => [...watched];

export function updateWatched(a: ActionDto): void {
  if (!watched.has(a.id)) return;
  if (!isOpen(a)) unwatch(a.id);
  show(a);
}

/** The action no longer exists server-side: stop watching and drop its toast. */
export function forgetWatched(id: string): void {
  unwatch(id);
  toast.dismiss(id);
}

/** Fetching the action failed; keep watching (a later signal or reconnect may succeed) but warn once per id. */
export function refreshFailed(id: string, error: unknown): void {
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`infra: could not refresh action ${id}`, error);
}
