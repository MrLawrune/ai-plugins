// Toasts for actions started in this window: one toast per action, updated as infra:task signals arrive.
import { toast } from "sonner";
import type { ActionDto } from "../schemas.ts";
import { isOpen, progressText } from "./actions-model.ts";

const watched = new Set<string>();

function show(a: ActionDto): void {
  const p = progressText(a);
  const opts = { id: a.id, description: isOpen(a) ? a.lastLine ?? undefined : a.status === "failed" ? a.error?.split("\n").slice(-3).join("\n") : undefined };
  if (p.tone === "loading") toast.loading(p.text, opts);
  else if (p.tone === "success") toast.success(p.text, opts);
  else if (p.tone === "warning") toast.warning(p.text, opts);
  else toast.error(p.text, { ...opts, duration: 15_000 });
}

export function watchAction(a: ActionDto): void {
  if (isOpen(a)) watched.add(a.id);
  show(a);
}

export const isWatched = (id: string) => watched.has(id);

export function updateWatched(a: ActionDto): void {
  if (!watched.has(a.id)) return;
  if (!isOpen(a)) watched.delete(a.id);
  show(a);
}
