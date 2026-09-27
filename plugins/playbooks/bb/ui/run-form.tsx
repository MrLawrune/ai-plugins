// Run confirmation form: shared by the composer interaction and the panel dialog.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { EnvBadgeDto, RunSpec } from "../shared/types.ts";
import { EnvBadge } from "./badges.tsx";
import { applyDisabledReason, initialState, toSpec, validate, type FormState, type RunPolicy } from "./run-form-model.ts";

export interface RunFormProps {
  env: EnvBadgeDto; playbook: string; initial: RunSpec; inventories: string[]; credRefs: { id: string; name: string }[];
  policy: RunPolicy; summaryLine?: string | undefined;
  onSubmit(spec: RunSpec, typed: string | undefined): void; onCancel(): void; busy: boolean;
}

const NONE = "__none__";
const CUSTOM = "__custom__";

function Field({ label, error, children }: { label: string; error?: string | undefined; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function RunForm({ env, playbook, initial, inventories, credRefs, policy, summaryLine, onSubmit, onCancel, busy }: RunFormProps) {
  const [s, setS] = useState<FormState>(() => initialState(initial));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((x) => ({ ...x, [k]: v }));
  const errors = useMemo(() => validate(s), [s]);
  const blocked = applyDisabledReason(policy, s, playbook);
  const invalid = Object.keys(errors).length > 0;
  
  const [customInv, setCustomInv] = useState(() => initial.inventory !== "" && !inventories.includes(initial.inventory));
  const phrase = policy.phrase ?? playbook;
  const needsTyped = policy.applyNeedsTyped && !s.check;

  return (
    <form
      className="space-y-3 rounded-lg border bg-card p-3 text-sm"
      onSubmit={(e) => { e.preventDefault(); if (!blocked && !invalid && !busy) onSubmit(toSpec(s), needsTyped ? s.typed : undefined); }}
    >
      <div className="flex items-center gap-2">
        <EnvBadge env={env} />
        <span className="min-w-0 flex-1 truncate font-medium">{playbook}</span>
      </div>
      {summaryLine ? <p className="text-xs text-muted-foreground">{summaryLine}</p> : null}

      <div className="flex items-center justify-between gap-3 rounded-md border px-2 py-1.5">
        <div>
          <div className="text-xs font-medium">{s.check ? "Check (dry run, with diff)" : "Apply"}</div>
          <div className="text-xs text-muted-foreground">{s.check ? "Shows what would change; nothing is changed." : "Makes real changes on the hosts."}</div>
        </div>
        <Switch checked={s.check} onCheckedChange={(v) => set("check", v)} aria-label="Check mode" />
      </div>
      {blocked && !s.check ? <p className="text-xs text-destructive">{blocked}</p> : null}
      {needsTyped && policy.applyAllowed ? (
        <Field label={`Type ${phrase} to confirm`}>
          <Input value={s.typed} onChange={(e) => set("typed", e.target.value)} placeholder={phrase} autoComplete="off" />
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Inventory" error={errors.inventory}>
          <Select value={customInv ? CUSTOM : s.inventory || NONE} onValueChange={(v) => { if (v === CUSTOM) { setCustomInv(true); } else { setCustomInv(false); set("inventory", v === NONE ? "" : v); } }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Default</SelectItem>
              {inventories.map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}
              <SelectItem value={CUSTOM}>Custom…</SelectItem>
            </SelectContent>
          </Select>
          {customInv ? <Input value={s.inventory} onChange={(e) => set("inventory", e.target.value)} placeholder="path/to/inventory" autoComplete="off" /> : null}
        </Field>
        <Field label="Limit" error={errors.limit}>
          <Input value={s.limit} onChange={(e) => set("limit", e.target.value)} placeholder="web-01" />
        </Field>
        <Field label="Tags" error={errors.tags}>
          <Input value={s.tags} onChange={(e) => set("tags", e.target.value)} placeholder="deploy, config" />
        </Field>
        <Field label="Skip tags" error={errors.skipTags}>
          <Input value={s.skipTags} onChange={(e) => set("skipTags", e.target.value)} />
        </Field>
        <Field label="Credentials">
          <Select value={s.credRefId ?? NONE} onValueChange={(v) => set("credRefId", v === NONE ? null : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Default</SelectItem>
              {credRefs.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Verbosity">
          <Select value={String(s.verbosity)} onValueChange={(v) => set("verbosity", Number(v) as RunSpec["verbosity"])}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{[0, 1, 2, 3, 4].map((n) => <SelectItem key={n} value={String(n)}>{n === 0 ? "Normal" : "v".repeat(n)}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Extra variables" error={errors.extraVars}>
        <div className="space-y-1.5">
          {s.extraVars.map((r, i) => (
            <div key={i} className="flex gap-1.5">
              <Input value={r.key} placeholder="name" className="w-2/5" onChange={(e) => set("extraVars", s.extraVars.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
              <Input value={r.value} placeholder="value or JSON" onChange={(e) => set("extraVars", s.extraVars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <Button type="button" variant="ghost" size="sm" aria-label="Remove variable" onClick={() => set("extraVars", s.extraVars.filter((_, j) => j !== i))}>✕</Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => set("extraVars", [...s.extraVars, { key: "", value: "" }])}>Add variable</Button>
        </div>
      </Field>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || invalid || blocked !== null}>{busy ? "Starting…" : s.check ? "Run check" : "Run"}</Button>
      </div>
    </form>
  );
}
