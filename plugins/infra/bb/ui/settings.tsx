// Settings: environments (name, kind, rules, export) and their Proxmox connections (URL, credential, TLS).
import { useState, type ReactNode } from "react";
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
import type { CertInfo, ConnectionDto, ConnectionSaveInput, EnvKind, EnvSaveInput, InfraEnvRow } from "../schemas.ts";
import { EnvBadge, HealthBadge } from "./badges.tsx";
import { KIND_DEFAULT_COLORS, slugify } from "./format.ts";
import { DEFAULT_POLL_SECONDS } from "../shared/constants.ts";
import { useInfraQuery, useInfraRpc, useNow } from "./hooks.ts";

const KINDS: EnvKind[] = ["lab", "dev", "staging", "prod", "customer", "other"];
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SettingsSection() {
  const q = useInfraQuery("settingsGet", {});
  const [editingEnv, setEditingEnv] = useState<InfraEnvRow | "new" | null>(null);
  const [editingConn, setEditingConn] = useState<{ env: InfraEnvRow; conn: ConnectionDto | null } | null>(null);
  const now = useNow();

  if (q.error && !q.data) return <p className="text-sm text-destructive">Could not load settings: {q.error}</p>;
  const envs = q.data?.envs ?? [];
  const conns = q.data?.connections ?? [];

  return (
    <div className="space-y-4">
      {envs.length === 0 && !q.loading ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No environments yet. Add one for each place your agents work: a homelab, a staging cluster, a customer's production.
        </div>
      ) : null}
      {envs.map((env) => (
        <div key={env.id} className="space-y-3 rounded-lg border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <EnvBadge env={env} />
              <code className="truncate text-xs text-muted-foreground">{env.slug}</code>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" onClick={() => setEditingConn({ env, conn: null })}>Add connection</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingEnv(env)}>Edit</Button>
            </div>
          </div>
          {conns.filter((c) => c.envId === env.id).map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left hover:bg-state-hover"
              onClick={() => setEditingConn({ env, conn: c })}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{c.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{c.baseUrl} · {c.authKind === "token" ? "API token" : "password"} · TLS {c.tlsMode}{c.hasSecret ? "" : " · no credential"}</span>
              </span>
              {c.health ? <HealthBadge code={c.health.code} staleSince={c.health.staleSince} now={now} /> : null}
            </button>
          ))}
        </div>
      ))}
      <Button variant="outline" onClick={() => setEditingEnv("new")}>Add environment</Button>
      <SetupHelp />
      {editingEnv ? <EnvDialog env={editingEnv === "new" ? null : editingEnv} onClose={() => { setEditingEnv(null); q.refresh(); }} /> : null}
      {editingConn ? <ConnectionDialog env={editingConn.env} conn={editingConn.conn} onClose={() => { setEditingConn(null); q.refresh(); }} /> : null}
    </div>
  );
}

function SetupHelp() {
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">Create a read-only Proxmox token</summary>
      <p className="mt-2 text-muted-foreground">Run on each standalone host (or once per cluster). The plugin only reads; whatever the role allows is what you see.</p>
      <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-xs">{[
        'pveum user add bb-view@pve --comment "BB Infra (read-only)"',
        "pveum aclmod / -user bb-view@pve -role PVEAuditor",
        "pveum user token add bb-view@pve infra --privsep 0",
      ].join("\n")}</pre>
      <p className="mt-2 text-muted-foreground">Then add a connection with username <code>bb-view@pve!infra</code> and the token's secret value.</p>
    </details>
  );
}

function EnvDialog({ env, onClose }: { env: InfraEnvRow | null; onClose(): void }) {
  const call = useInfraRpc();
  const [form, setForm] = useState<EnvSaveInput>(() => env
    ? { id: env.id, slug: env.slug, name: env.name, kind: env.kind, color: env.color, pollSeconds: env.pollSeconds, rules: env.rules, exportDir: env.exportDir, ipRefreshMinutes: env.ipRefreshMinutes, conventionsPath: env.conventionsPath }
    : { slug: "", name: "", kind: "lab", color: KIND_DEFAULT_COLORS.lab, pollSeconds: DEFAULT_POLL_SECONDS.lab, rules: "", exportDir: "", ipRefreshMinutes: 5, conventionsPath: "" });
  const [slugTouched, setSlugTouched] = useState(!!env);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof EnvSaveInput>(k: K, v: EnvSaveInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      await call("envSave", { ...form, slug: form.slug || slugify(form.name) });
      toast.success(`Saved ${form.name}`);
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!env) return;
    try {
      await call("envDelete", { id: env.id });
      toast.success(`Removed ${env.name}`);
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{env ? `Edit ${env.name}` : "Add environment"}</DialogTitle>
          <DialogDescription>An environment groups the Proxmox hosts or clusters of one place, such as your homelab or a customer's production.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => { const name = e.target.value; setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) })); }} placeholder="Homelab" />
            </Field>
            <Field label="Slug" hint="Used in targets like homelab/pve1/201">
              <Input value={form.slug} onChange={(e) => { setSlugTouched(true); set("slug", e.target.value); }} placeholder="homelab" />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Kind">
              <Select value={form.kind} onValueChange={(v) => { const kind = v as EnvKind; setForm((f) => ({ ...f, kind, color: KIND_DEFAULT_COLORS[kind], pollSeconds: f.pollSeconds === DEFAULT_POLL_SECONDS[f.kind] ? DEFAULT_POLL_SECONDS[kind] : f.pollSeconds })); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Color">
              <Input type="color" value={form.color} disabled={form.kind === "prod"} onChange={(e) => set("color", e.target.value)} className="h-9 p-1" />
            </Field>
            <Field label="Poll every (s)">
              <Input type="number" min={5} max={300} value={form.pollSeconds} onChange={(e) => set("pollSeconds", Number(e.target.value))} />
            </Field>
          </div>
          <Field label="Guest IP sweep (minutes)" hint="How often to read guest IPs (one request per running guest). 0 turns it off; IPs then load when you open a guest.">
            <Input type="number" min={0} max={1440} value={form.ipRefreshMinutes ?? 5} onChange={(e) => set("ipRefreshMinutes", Number(e.target.value))} />
          </Field>
          <Field label="Rules for agents" hint="Short conventions agents get with this environment's context, e.g. “Podman, not Docker”, “prefer LXCs”, “new CTs go in pool bb-lab”.">
            <Textarea rows={4} value={form.rules} onChange={(e) => set("rules", e.target.value)} maxLength={4096} />
          </Field>
          <Field label="Conventions file (optional)" hint="Absolute path on the BB server to an existing AGENTS.md, runbook, or conventions doc. Agents get it with this environment's rules.">
            <Input value={form.conventionsPath ?? ""} onChange={(e) => set("conventionsPath", e.target.value)} placeholder="/srv/docs/AGENTS.md" />
          </Field>
          <Field label="Export folder (optional)" hint="Writes <slug>-registry.md and <slug>-rules.md here on every change, e.g. a notes vault folder.">
            <Input value={form.exportDir} onChange={(e) => set("exportDir", e.target.value)} placeholder="/home/me/notes/Infra" />
          </Field>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {env ? <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>Delete</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void save()} disabled={busy || !form.name.trim()}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {env?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This removes its connections, stored credentials, and recorded agent activity from BB. Nothing changes on the Proxmox hosts.</AlertDialogDescription>
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

function ConnectionDialog({ env, conn, onClose }: { env: InfraEnvRow; conn: ConnectionDto | null; onClose(): void }) {
  const call = useInfraRpc();
  const [form, setForm] = useState<ConnectionSaveInput>(() => conn
    ? { id: conn.id, envId: env.id, label: conn.label, baseUrl: conn.baseUrl, authKind: conn.authKind, username: conn.username, tlsMode: conn.tlsMode, tlsFingerprint: conn.tlsFingerprint, enabled: conn.enabled, webUrl: conn.webUrl }
    : { envId: env.id, label: "", baseUrl: "https://", authKind: "token", username: "bb-view@pve!infra", tlsMode: "pinned", tlsFingerprint: "", enabled: true });
  const [secret, setSecret] = useState("");
  const [caPem, setCaPem] = useState("");
  const [cert, setCert] = useState<CertInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  const set = <K extends keyof ConnectionSaveInput>(k: K, v: ConnectionSaveInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const probe = async () => {
    setCert(null);
    const r = await call("connectionProbe", { baseUrl: form.baseUrl });
    if (r.ok) setCert(r.cert); else toast.error(`Could not read the certificate: ${r.error}`);
  };
  const save = async (): Promise<string | null> => {
    setBusy(true);
    try {
      const r = await call("connectionSave", { ...form, ...(secret ? { secret } : {}), ...(caPem.trim() ? { caPem } : {}) });
      setForm((f) => ({ ...f, id: r.connection.id }));
      setSecret("");
      return r.connection.id;
    } catch (e) {
      toast.error(errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const saveAndTest = async () => {
    const id = await save();
    if (!id) return;
    setTest("Testing…");
    const r = await call("connectionTest", { id });
    setTest(r.health?.code === "ok" ? `Connected · Proxmox VE ${r.version ?? "?"}` : `${r.health?.code ?? "not tested"}${r.health?.message ? `: ${r.health.message}` : ""}`);
  };
  const remove = async () => {
    if (!form.id) return;
    await call("connectionDelete", { id: form.id }).then(() => { toast.success(`Removed ${form.label}`); onClose(); }, (e: unknown) => toast.error(errorText(e)));
  };
  const hasSecret = conn?.hasSecret && !secret;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{conn ? `Edit ${conn.label}` : `Add connection to ${env.name}`}</DialogTitle>
          <DialogDescription>A Proxmox VE API endpoint: one standalone host, or any node of a cluster.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label"><Input value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="pve1" /></Field>
            <Field label="URL"><Input value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://192.0.2.10:8006" /></Field>
          </div>
          <Field label="Web UI link (optional)" hint="Where your browser reaches this host's Proxmox UI, e.g. through a reverse proxy. Used by “Open in Proxmox”; leave empty to use the URL above.">
            <Input value={form.webUrl ?? ""} onChange={(e) => set("webUrl", e.target.value)} placeholder="https://pve1.example.com" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sign in with">
              <Select value={form.authKind} onValueChange={(v) => set("authKind", v as "token" | "password")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="token">API token</SelectItem><SelectItem value="password">Username and password</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label={form.authKind === "token" ? "Token ID" : "Username"}>
              <Input value={form.username} onChange={(e) => set("username", e.target.value)} placeholder={form.authKind === "token" ? "bb-view@pve!infra" : "root@pam"} />
            </Field>
          </div>
          <Field label={form.authKind === "token" ? "Token secret" : "Password"} hint="Stored as a BB secret. Never shown again or sent to agents.">
            <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={hasSecret ? "•••••••• saved — type to replace" : ""} />
          </Field>
          <Field label="Certificate">
            <Select value={form.tlsMode} onValueChange={(v) => set("tlsMode", v as ConnectionSaveInput["tlsMode"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pinned">Trust this host's certificate (recommended)</SelectItem>
                <SelectItem value="ca">Verify with a CA certificate</SelectItem>
                <SelectItem value="insecure">Don't verify (insecure)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {form.tlsMode === "pinned" ? (
            <div className="space-y-2 rounded-md border p-2 text-xs">
              {form.tlsFingerprint ? <p className="break-all"><span className="text-muted-foreground">Trusted:</span> <code>{form.tlsFingerprint}</code></p> : <p className="text-muted-foreground">No certificate trusted yet.</p>}
              {cert ? (
                <div className="space-y-1">
                  <p className="break-all"><span className="text-muted-foreground">Found:</span> <code>{cert.fingerprint256}</code></p>
                  <p className="text-muted-foreground">Subject {cert.subject || "?"} · issued by {cert.issuer || "?"} · expires {cert.validTo}</p>
                  <Button size="sm" onClick={() => { set("tlsFingerprint", cert.fingerprint256); setCert(null); }}>Trust this certificate</Button>
                </div>
              ) : <Button size="sm" variant="outline" onClick={() => void probe()} disabled={!form.baseUrl.startsWith("https://")}>Fetch certificate</Button>}
            </div>
          ) : null}
          {form.tlsMode === "ca" ? (
            <Field label="CA certificate (PEM)" hint={conn?.hasCaPem && !caPem ? "A CA certificate is saved; paste to replace." : undefined}>
              <Textarea rows={4} value={caPem} onChange={(e) => setCaPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
            </Field>
          ) : null}
          {form.tlsMode === "insecure" ? <p className="text-xs text-amber-600 dark:text-amber-400">Anyone on the network path could impersonate this host and receive the credential.</p> : null}
          <label className="flex items-center gap-2 text-sm"><Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} /> Poll this connection</label>
          {test ? <p className="text-xs">{test}</p> : null}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {form.id ? <Button variant="ghost" className="text-destructive" onClick={() => void remove()}>Delete</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void saveAndTest()} disabled={busy}>Save and test</Button>
            <Button onClick={() => void save().then((id) => { if (id) { toast.success(`Saved ${form.label}`); onClose(); } })} disabled={busy}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
