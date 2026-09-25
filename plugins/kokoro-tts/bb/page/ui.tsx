// bb-plugin-kokoro-tts — shared layout primitives for the Kokoro settings page.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Debounce a value-setter for slider drags; commit after `ms` of quiet. */
export function useDebouncedPatch<P>(patch: (p: P) => Promise<void>, ms = 350) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (p: P) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void patch(p), ms);
    },
    [patch, ms],
  );
}

export function Section({ title, description, children, actions }: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </header>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </section>
  );
}

export function Row({ label, hint, children, htmlFor }: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,12rem)_1fr]">
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="text-sm">{label}</Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function SliderRow({ id, label, hint, value, min, max, step, format, onChange }: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <div className="flex items-center gap-3">
        <Slider
          id={id}
          min={min}
          max={max}
          step={step}
          value={[local]}
          onValueChange={([v]) => {
            setLocal(v);
            onChange(v);
          }}
          className="flex-1"
        />
        <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {format(local)}
        </span>
      </div>
    </Row>
  );
}

export function SwitchRow({ id, label, hint, checked, onChange }: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Row>
  );
}

/** A native disclosure for secondary controls, styled like the former "Paths and restart" block. */
export function Advanced({ label = "Advanced", children }: { label?: string; children: ReactNode }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">{label}</summary>
      <div className="mt-2 space-y-3">{children}</div>
    </details>
  );
}
