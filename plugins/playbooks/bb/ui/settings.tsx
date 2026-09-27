// Settings: environments (control host, repo, kind, rules, approval) with connection test.
import { useEffect, useState, type ReactNode } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { EnvHealth, EnvSettingsDto } from "../schemas.ts";
import { ENV_KINDS, RULES_MAX, type EnvKind } from "../shared/constants.ts";
import { EnvBadge, HealthBadge } from "./badges.tsx";
import { usePlaybooksQuery, usePlaybooksRpc } from "./hooks.ts";
import { canRelaxApproval, colorForKindChange, emptyEnvForm, failedTest, slugify, testResultView, validateEnvForm, type EnvForm } from "./settings-model.ts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const THIS_SERVER = "__server__";

function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | undefined; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function TestResult({ health }: { health: EnvHealth }) {
  const { details, message } = testResultView(health);
  return (
    <div className="space-y-0.5 text-xs">
      <p className="text-muted-foreground">{details}</p>
      {message ? <p className="text-destructive">{message}</p> : null}
    </div>
  );
}

export function SettingsSection() {
  const q = usePlaybooksQuery("settings.get", {});
  const call = usePlaybooksRpc();
  const [editing, setEditing] = useState<EnvSettingsDto | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, EnvHealth>>({});

  if (q.error && !q.data) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-sm text-destructive">Could not load settings: {q.error}</p>
        <Button size="sm" variant="outline" onClick={q.refresh}>Retry</Button>
      </div>
    );
  }
  const envs = q.data?.envs ?? [];

  const test = async (env: EnvSettingsDto) => {
    setTesting(env.id);
    try {
      const r = await call("env.test", { id: env.id });
      setResults((s) => ({ ...s, [env.id]: r.health }));
    } catch (e) {
      setResults((s) => ({ ...s, [env.id]: failedTest(errorText(e)) }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-4">
      {q.data?.gap ? <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{q.data.gap}</p> : null}
      {envs.length === 0 && !q.loading && !q.data?.gap ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No environments yet. Add one for each control host you run playbooks from.</div>
      ) : null}
      {envs.map((env) => {
        const r = results[env.id];
        const health = r ?? env.health;
        return (
          <div key={env.id} className="space-y-2 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <EnvBadge env={env} />
                <code className="truncate text-xs text-muted-foreground">{env.slug}</code>
                {health ? <HealthBadge code={health.code} /> : env.enabled ? null : <HealthBadge code="disabled" />}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="ghost" disabled={testing === env.id} onClick={() => void test(env)}>{testing === env.id ? "Testing…" : "Test connection"}</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(env)}>Edit</Button>
              </div>
            </div>
            <p className="truncate text-xs text-muted-foreground">{env.controlHost} · {env.repoPath}</p>
            {health ? <TestResult health={health} /> : null}
          </div>
        );
      })}
      <Button variant="outline" onClick={() => setEditing("new")}>Add environment</Button>
      <SetupHelp />
      {editing ? <EnvDialog env={editing === "new" ? null : editing} onClose={(saved) => { setEditing(null); if (saved) setResults((r) => { const { [saved]: _drop, ...rest } = r; return rest; }); q.refresh(); }} /> : null}
    </div>
  );
}

function SetupHelp() {
  return (
    <details className="rounded-lg border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">What the control host needs</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        <li><code>ansible-core</code>, <code>ansible-runner</code>, and <code>python3</code> installed for the user you connect as.</li>
        <li>Key-based SSH from the BB machine to the control host (no password prompts); use an alias from your SSH config or a host name.</li>
        <li>A git checkout of your playbooks on the control host; give its absolute path as the repository path.</li>
      </ul>
      <p className="mt-2 text-muted-foreground">The plugin reads and runs playbooks from that checkout. It never writes playbook files.</p>
    </details>
  );
}

function EnvDialog({ env, onClose }: { env: EnvSettingsDto | null; onClose(savedId?: string): void }) {
  const call = usePlaybooksRpc();
  const sdk = useSdk();
  const [machines, setMachines] = useState<{ id: string; label: string }[]>([]);
  const [form, setForm] = useState<EnvForm>(() => {
    if (!env) return emptyEnvForm();
    const { id, slug, name, kind, color, rules, controlHost, hostId, repoPath, inventoryRoot, agentApproval, defaultCheck, infraEnvSlug, enabled } = env;
    return { id, slug, name, kind, color, rules, controlHost, hostId, repoPath, inventoryRoot, runnerKind: "ssh", agentApproval: agentApproval === "none" ? "none" : "form", defaultCheck, infraEnvSlug, enabled };
  });
  const [slugTouched, setSlugTouched] = useState(!!env);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof EnvForm>(k: K, v: EnvForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errors = validateEnvForm(form);

  useEffect(() => {
    let live = true;
    sdk.hosts.list().then((hosts) => { if (live) setMachines(hosts.map((h) => ({ id: h.id, label: (h as { name?: string }).name ?? h.id }))); }, () => {});
    return () => { live = false; };
  }, [sdk]);

  const save = async () => {
    if (Object.keys(errors).length > 0) { setShowErrors(true); return; }
    setBusy(true);
    try {
      const r = await call("env.save", { ...form, agentApproval: canRelaxApproval(form.kind) ? form.agentApproval : "form" });
      toast.success(`Saved ${form.name}`);
      onClose(r.env.id);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!env) return;
    try {
      await call("env.delete", { id: env.id });
      toast.success(`Removed ${env.name}`);
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const err = (k: keyof typeof errors) => (showErrors ? errors[k] : undefined);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{env ? `Edit ${env.name}` : "Add environment"}</DialogTitle>
          <DialogDescription>An environment is one control host and the playbook repository on it.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" error={err("name")}>
              <Input value={form.name} onChange={(e) => { const name = e.target.value; setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) })); }} placeholder="Lab" />
            </Field>
            <Field label="Slug" hint="Used in targets like lab/site.yml" error={err("slug")}>
              <Input value={form.slug} onChange={(e) => { setSlugTouched(true); set("slug", e.target.value); }} placeholder="lab" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind">
              <Select value={form.kind} onValueChange={(v) => { const kind = v as EnvKind; setForm((f) => ({ ...f, kind, color: colorForKindChange(f.kind, f.color, kind), agentApproval: canRelaxApproval(kind) ? f.agentApproval : "form" })); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{ENV_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Color" error={err("color")}>
              <Input type="color" value={form.color} disabled={form.kind === "prod"} onChange={(e) => set("color", e.target.value)} className="h-9 p-1" />
            </Field>
          </div>
          <Field label="Machine" hint="The BB machine that opens the SSH connection. “This server” is the machine running BB.">
            <Select value={form.hostId ?? THIS_SERVER} onValueChange={(v) => set("hostId", v === THIS_SERVER ? null : v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={THIS_SERVER}>This server</SelectItem>
                {machines.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Control host" hint="SSH alias or host name, as used in your SSH config." error={err("controlHost")}>
            <Input value={form.controlHost} onChange={(e) => set("controlHost", e.target.value)} placeholder="web-01" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Repository path" hint="Absolute path on the control host." error={err("repoPath")}>
              <Input value={form.repoPath} onChange={(e) => set("repoPath", e.target.value)} placeholder="/srv/example" />
            </Field>
            <Field label="Inventory folder (optional)" hint="Absolute path inside the repository; empty uses the repository itself." error={err("inventoryRoot")}>
              <Input value={form.inventoryRoot} onChange={(e) => set("inventoryRoot", e.target.value)} placeholder="/srv/example/inventories" />
            </Field>
          </div>
          <Field label="Rules for agents" hint="Short conventions agents get with this environment, e.g. “always run with --check first”." error={err("rules")}>
            <Textarea rows={4} value={form.rules} onChange={(e) => set("rules", e.target.value)} maxLength={RULES_MAX} />
          </Field>
          <Field label="Agent approval" hint={canRelaxApproval(form.kind) ? "“No form” lets agents start check runs without a confirmation form." : "Agent runs always need the confirmation form outside lab and dev."}>
            <Select value={canRelaxApproval(form.kind) ? form.agentApproval : "form"} disabled={!canRelaxApproval(form.kind)} onValueChange={(v) => set("agentApproval", v === "none" ? "none" : "form")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="form">Confirmation form</SelectItem><SelectItem value="none">No form for check runs</SelectItem></SelectContent>
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm"><Switch checked={form.defaultCheck} onCheckedChange={(v) => set("defaultCheck", v)} /> Run in check mode by default</label>
          <label className="flex items-center gap-2 text-sm"><Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} /> Enabled</label>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {env ? <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>Delete</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onClose()}>Cancel</Button>
            <Button onClick={() => void save()} disabled={busy}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {env?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the environment, its run history, and stored credential references from BB. Nothing changes on the control host.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
