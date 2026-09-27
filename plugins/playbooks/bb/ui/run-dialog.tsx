// Run dialog opened from the panel (Run ▸): prepares policy, shows the form, starts the run, opens it in the panel.
import { useBbContext } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RunSpec } from "../shared/types.ts";
import { usePlaybooksQuery, usePlaybooksRpc } from "./hooks.ts";
import { useOpenPanel } from "./panel-open.ts";
import { RunForm } from "./run-form.tsx";
import type { RunPolicy } from "./run-form-model.ts";

const DEFAULT_SPEC: RunSpec = { inventory: "", limit: "", tags: [], skipTags: [], extraVars: {}, credRefId: null, check: true, diff: true, verbosity: 0, branch: null };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `initialSpec` seeds the form (Rerun passes the previous run's spec); `surface` records where the run was started from. */
export function RunDialog({ env, file, open, onClose, initialSpec, surface = "panel" }: { env: string; file: string; open: boolean; onClose(): void; initialSpec?: Partial<RunSpec>; surface?: "panel" | "card" | "page" }) {
  const { threadId } = useBbContext();
  const call = usePlaybooksRpc();
  const openPanel = useOpenPanel();
  const overview = usePlaybooksQuery("overview", open ? {} : null, { refreshOn: [] });
  const invs = usePlaybooksQuery("inventories.list", open ? { env } : null, { refreshOn: [] });
  const creds = usePlaybooksQuery("credrefs.list", open ? { env } : null, { refreshOn: [] });
  const [policy, setPolicy] = useState<{ policy: RunPolicy; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const badge = overview.data?.envs.find((e) => e.env.slug === env)?.env ?? null;
  const source = { surface, threadId };

  const initial = useMemo<RunSpec>(() => {
    const first = invs.data?.inventories[0]?.path ?? "";
    return { ...DEFAULT_SPEC, inventory: first, ...initialSpec, check: initialSpec?.check ?? true, diff: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invs.data]);

  // Policy for an apply run decides what the form may offer; check mode is always allowed to preselect.
  useEffect(() => {
    if (!open || !invs.data) return;
    let live = true;
    setPolicy(null);
    call("run.prepare", { env, file, spec: { ...initial, check: false, diff: false }, source }).then(
      (p) => { if (live) setPolicy(p.allowed ? { policy: { applyAllowed: true, applyNeedsTyped: p.confirm === "typed", phrase: p.phrase }, reason: null } : { policy: { applyAllowed: false, applyNeedsTyped: false, phrase: null, blockedReason: p.reason }, reason: p.reason }); },
      (e: unknown) => { if (live) { toast.error(`Could not prepare the run: ${errorText(e)}`); onClose(); } },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invs.data, env, file]);

  const start = async (spec: RunSpec, typed: string | undefined) => {
    setBusy(true);
    try {
      const { runId } = await call("run.start", { env, file, spec, source, ...(typed !== undefined ? { typed } : {}) });
      toast.success(`Started ${file}${spec.check ? " (check)" : ""}`);
      onClose();
      openPanel({ runId }, "Run");
    } catch (e) {
      toast.error(`Could not start the run: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const invRows = invs.data?.inventories, credRows = creds.data?.credRefs;
  const loadError = overview.error ?? invs.error ?? creds.error;
  const retry = () => { overview.refresh(); invs.refresh(); creds.refresh(); };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Run {file}</DialogTitle></DialogHeader>
        {loadError ? (
          <div className="text-xs text-destructive">Could not load the run form: {loadError} <Button variant="link" size="sm" onClick={retry}>Retry</Button></div>
        ) : badge && invRows && credRows && policy ? (
          <RunForm
            env={badge} playbook={file} initial={initial} inventories={invRows.map((i) => i.path)}
            credRefs={credRows.map((c) => ({ id: c.id, name: c.name }))} policy={policy.policy}
            onSubmit={(spec, typed) => void start(spec, typed)} onCancel={onClose} busy={busy}
          />
        ) : <div className="h-32 animate-pulse rounded-lg border bg-muted/40" />}
      </DialogContent>
    </Dialog>
  );
}
