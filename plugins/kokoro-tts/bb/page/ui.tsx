// Layout and control primitives for the Kokoro settings surfaces.
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { SaveState } from "./patch-queue.ts";
import type { Tone } from "./status.ts";

export { errorText } from "../util.ts";

export function Section({ title, description, children, actions }: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="space-y-4 py-5 first:pt-0">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </header>
      <div className="space-y-4">{children}</div>
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

export function ChoiceGroup<V extends string>({ label, value, options, onChange, disabled }: {
  label: string;
  value: V;
  options: { value: V; label: string; hint?: string }[];
  onChange: (v: V) => void;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const hintId = useId();
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[index];
  const move = (to: number) => {
    const n = (to + options.length) % options.length;
    onChange(options[n].value);
    refs.current[n]?.focus();
  };
  return (
    <div>
      <div
        role="radiogroup"
        aria-label={label}
        aria-describedby={selected?.hint ? hintId : undefined}
        className="flex flex-wrap gap-1.5"
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            move(index + 1);
          } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            move(index - 1);
          }
        }}
      >
        {options.map((o, i) => (
          <Button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            variant={o.value === value ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>
      {selected?.hint ? <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">{selected.hint}</p> : null}
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
  const dragging = useRef(false);
  // A refresh arriving mid-drag must not snap the thumb back.
  useEffect(() => { if (!dragging.current) setLocal(value); }, [value]);
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <div className="flex items-center gap-3">
        <Slider
          id={id}
          min={min}
          max={max}
          step={step}
          value={[local]}
          thumbLabel={label}
          thumbValueText={format(local)}
          onValueChange={([v]) => {
            dragging.current = true;
            setLocal(v);
            onChange(v);
          }}
          onValueCommit={() => { dragging.current = false; }}
          className="flex-1"
        />
        <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground" aria-hidden>
          {format(local)}
        </span>
      </div>
    </Row>
  );
}

export function SwitchRow({ id, label, hint, checked, onChange, disabled }: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm">{label}</Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5 shrink-0" />
    </div>
  );
}

export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">{label}</summary>
      <div className="mt-3 space-y-4">{children}</div>
    </details>
  );
}

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  busy: "bg-sky-500 animate-pulse",
  warn: "bg-amber-500",
  error: "bg-destructive",
};

export function StatusDot({ tone }: { tone: Tone }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", TONE_DOT[tone])} />;
}

export function SaveIndicator({ state }: { state: SaveState }) {
  switch (state.kind) {
    case "saving":
      return <span className="text-xs text-muted-foreground" role="status">Saving…</span>;
    case "saved":
      return <span className="text-xs text-muted-foreground" role="status">Saved</span>;
    case "error":
      return (
        <span className="flex items-center gap-2 text-xs text-destructive" role="alert">
          Not saved: {state.message}
          <Button variant="outline" size="sm" onClick={state.retry}>Retry</Button>
        </span>
      );
    default:
      return null;
  }
}
