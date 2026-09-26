// Guest action control: primary state button + Actions menu, confirm and snapshot dialogs, running-task pill.
import { Fragment, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { snapshotNameError } from "../shared/actions.ts";
import type { ActionDto, ActionKind, ActionParams, ActionSource, GuestState, PrepareResult } from "../schemas.ts";
import { watchAction } from "./action-toasts.ts";
import { ACTION_LABEL, canSubmit, menuActions, primaryAction, progressText } from "./actions-model.ts";
import { EnvBadge } from "./badges.tsx";
import { useInfraQuery, useInfraRpc } from "./hooks.ts";
import { InfraIcon } from "./icons.tsx";

type Prepared = Extract<PrepareResult, { allowed: true }>;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** prepare → (dialog) → execute → toast. Returns `run` and the dialog element to render. */
export function useActionRunner(source: ActionSource) {
  const call = useInfraRpc();
  const [pending, setPending] = useState<Prepared | null>(null);
  // Synchronous in-flight guard: a double-click must not prepare or execute twice.
  const busy = useRef(false);
  const guarded = async (fn: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await fn();
    } finally {
      busy.current = false;
    }
  };

  const execute = async (token: string, typed?: string) => {
    try {
      const r = await call("actionExecute", { token, typed });
      if (!r.ok) toast.error(r.reason);
      else watchAction(r.action);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const run = (target: string, action: ActionKind, params: ActionParams = {}) => guarded(async () => {
    try {
      const p = await call("actionPrepare", { target, action, params, source });
      if (!p.allowed) { toast.error(p.reason); return; }
      if (p.confirm === "none") await execute(p.token);
      else setPending(p);
    } catch (e) {
      toast.error(errorText(e));
    }
  });

  const dialog = pending ? <ConfirmActionDialog prepared={pending} onCancel={() => setPending(null)} onConfirm={(typed) => { setPending(null); void guarded(() => execute(pending.token, typed)); }} /> : null;
  return { run, dialog };
}

function ConfirmActionDialog({ prepared: p, onCancel, onConfirm }: { prepared: Prepared; onCancel(): void; onConfirm(typed?: string): void }) {
  const [typed, setTyped] = useState("");
  const ok = canSubmit(p.confirm, p.phrase, typed);
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <EnvBadge env={p.env} className="self-start" />
          <AlertDialogTitle>{p.title}</AlertDialogTitle>
          <AlertDialogDescription>{p.summary}</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm">{p.consequence}</p>
        {p.confirm === "typed" ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Type <code className="font-semibold text-foreground">{p.phrase}</code> to confirm.</p>
            <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && ok) onConfirm(typed); }} />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={!ok} onClick={() => onConfirm(p.confirm === "typed" ? typed : undefined)}>{p.title.split(" on ")[0]!.replace(/\?$/, "")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SnapshotDialog({ guest, existing, onCancel, onSubmit }: { guest: Pick<GuestState, "type" | "state">; existing: string[]; onCancel(): void; onSubmit(p: ActionParams): void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [vmstate, setVmstate] = useState(false);
  const error = name ? snapshotNameError(name) ?? (existing.includes(name) ? `A snapshot named “${name}” already exists.` : null) : null;
  const ramAllowed = guest.type === "qemu" && guest.state === "running";
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Take snapshot</DialogTitle>
          <DialogDescription>Snapshots capture the guest's disks{ramAllowed ? " and, optionally, its RAM" : ""} so you can roll back later.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="before-upgrade" maxLength={40} />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" maxLength={1000} />
          {ramAllowed ? <label className="flex items-center gap-2 text-sm"><Checkbox checked={vmstate} onCheckedChange={(v) => setVmstate(v === true)} /> Include RAM</label> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button disabled={!name || !!error} onClick={() => onSubmit({ snapname: name, ...(description.trim() ? { description: description.trim() } : {}), ...(vmstate ? { vmstate: true } : {}) })}>Take snapshot</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GuestActions({ target, guest, source, variant, compact }: {
  target: string; guest: Pick<GuestState, "type" | "state" | "name" | "template">; source: ActionSource; variant: "header" | "row"; compact?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const q = useInfraQuery("actionOptions", variant === "header" || menuOpen ? { target } : null, { refreshOn: ["infra:changed", "infra:task"] });
  const { run, dialog } = useActionRunner(source);
  if (guest.template) return null;
  const data = q.data && q.data.found && q.data.enabled ? q.data : null;
  if (variant === "header" && !data) return null;
  const opt = (a: ActionKind) => data?.options.find((o) => o.action === a);
  const primary = primaryAction(guest.type, guest.state);
  const primaryOpt = primary ? opt(primary) : undefined;
  const items = menuActions(guest.type).filter((a) => opt(a) !== undefined || !data);
  const onItem = (a: ActionKind) => {
    if (a === "snapshot.create") setSnapshotOpen(true);
    else void run(target, a);
  };
  return (
    <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {variant === "header" && primary && primaryOpt ? (
        <span title={primaryOpt.reason ?? undefined}>
          <Button size="sm" variant={primary === "start" || primary === "resume" ? "default" : "outline"} disabled={!primaryOpt.allowed} onClick={() => void run(target, primary)}>
            {ACTION_LABEL[primary]}
          </Button>
        </span>
      ) : null}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button size={variant === "row" || compact ? "icon" : "sm"} variant="ghost" aria-label="Guest actions">{variant === "row" || compact ? "⋯" : "Actions ▾"}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {q.data && q.data.found && !q.data.enabled ? <DropdownMenuItem disabled>Actions are off for this environment</DropdownMenuItem> : null}
          {!q.data ? <DropdownMenuItem disabled>Loading…</DropdownMenuItem> : null}
          {data ? items.map((a, i) => {
            const o = opt(a)!;
            return (
              <Fragment key={a}>
                {a === "snapshot.create" && i > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem disabled={!o.allowed} title={o.reason ?? undefined} onSelect={() => onItem(a)}>
                  {ACTION_LABEL[a]}{!o.allowed && o.reason ? <span className="ml-2 max-w-[14rem] truncate text-xs text-muted-foreground">{o.reason}</span> : null}
                </DropdownMenuItem>
              </Fragment>
            );
          }) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {snapshotOpen && data ? (
        <SnapshotDialog guest={guest} existing={data.snapshots} onCancel={() => setSnapshotOpen(false)} onSubmit={(p) => { setSnapshotOpen(false); void run(target, "snapshot.create", p); }} />
      ) : null}
      {dialog}
    </span>
  );
}

export function ActionPill({ action, onClick }: { action: ActionDto; onClick(): void }) {
  const p = progressText(action);
  return (
    <button type="button" onClick={onClick} className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs hover:bg-state-hover" title={action.lastLine ?? undefined}>
      <InfraIcon name="spinner" className="size-3.5 animate-spin" />
      <span className="truncate">{p.text}{action.lastLine ? ` · ${action.lastLine}` : ""}</span>
    </button>
  );
}
