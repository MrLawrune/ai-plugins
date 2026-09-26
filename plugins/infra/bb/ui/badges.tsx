// Small shared visual atoms: environment badge, run-state dot, health badge, usage bar, chip.
import { cn } from "@/lib/utils";
import type { EnvBadgeDto, HealthCode, RunState } from "../schemas.ts";
import { healthLabel, kindColor, pct, stateTone } from "./format.ts";

export function EnvBadge({ env, className }: { env: EnvBadgeDto; className?: string }) {
  const color = kindColor(env.kind, env.color);
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", className)}
      style={{ borderColor: `${color}66`, backgroundColor: `${color}14` }}
      title={`${env.name} (${env.kind})`}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{env.name}</span>
      {env.kind === "prod" ? <span className="font-semibold uppercase tracking-wide" style={{ color }}>prod</span> : <span className="text-muted-foreground">{env.kind}</span>}
    </span>
  );
}

const TONE_CLASS = { ok: "bg-emerald-500", off: "bg-muted-foreground/50", warn: "bg-amber-500" } as const;

export function StateDot({ state, active, className }: { state: RunState | "online" | "offline"; active?: boolean; className?: string }) {
  const tone = state === "online" ? "ok" : state === "offline" ? "warn" : stateTone(state);
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-label={state} role="img">
      {active ? <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", TONE_CLASS[tone])} /> : null}
      <span className={cn("relative inline-flex size-2 rounded-full", TONE_CLASS[tone])} />
    </span>
  );
}

export function HealthBadge({ code, staleSince, now }: { code: HealthCode; staleSince: number | null; now: number }) {
  const tone = code === "ok" ? "text-emerald-600 dark:text-emerald-400" : code === "disabled" ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400";
  return <span className={cn("text-xs font-medium", tone)}>{healthLabel(code, staleSince, now)}</span>;
}

export function UsageBar({ used, total, label, detail }: { used: number; total: number; label: string; detail?: string }) {
  const p = pct(used, total);
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-muted-foreground" title={label}>{label}</span>
        <span className="tabular-nums">{p}%</span>
      </div>
      <Meter percent={p} label={label} />
      {detail ? <p className="truncate text-xs tabular-nums text-muted-foreground" title={detail}>{detail}</p> : null}
    </div>
  );
}

/** Bare usage meter: neutral until 75%, amber to 90%, red above. */
export function Meter({ percent, label, className }: { percent: number; label: string; className?: string }) {
  const tone = percent >= 90 ? "bg-red-500" : percent >= 75 ? "bg-amber-500" : "bg-foreground/70";
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)} role="meter" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full transition-[width]", tone)} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Small rounded label for flags, tags and list values. */
export function Chip({ children, mono, className }: { children: React.ReactNode; mono?: boolean; className?: string }) {
  return <span className={cn("inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[11px] leading-none", mono && "font-mono", className)}>{children}</span>;
}
