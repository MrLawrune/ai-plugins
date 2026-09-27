// Small shared visual atoms: environment badge, run-status dot, cell glyph, health badge.
import { cn } from "@/lib/utils";
import { KIND_COLORS } from "../shared/constants.ts";
import { glyph, statusLabel } from "../shared/format.ts";
import type { CellState, EnvBadgeDto, EnvHealthCode, RunStatus } from "../shared/types.ts";

export function EnvBadge({ env, className }: { env: EnvBadgeDto; className?: string }) {
  const color = /^#[0-9a-fA-F]{6}$/.test(env.color) ? env.color : KIND_COLORS[env.kind];
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

const STATUS_TONE: Record<RunStatus, string> = {
  queued: "bg-muted-foreground/50", starting: "bg-amber-500", running: "bg-amber-500", success: "bg-emerald-500", failed: "bg-destructive", canceled: "bg-muted-foreground/50", unknown: "bg-amber-500",
};

export function StatusDot({ status, className }: { status: RunStatus; className?: string }) {
  const active = status === "running" || status === "starting";
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-label={statusLabel(status)} role="img">
      {active ? <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", STATUS_TONE[status])} /> : null}
      <span className={cn("relative inline-flex size-2 rounded-full", STATUS_TONE[status])} />
    </span>
  );
}

const CELL_TONE: Record<CellState, string> = {
  pending: "text-muted-foreground", running: "text-amber-600 dark:text-amber-400", ok: "text-emerald-600 dark:text-emerald-400", changed: "text-sky-600 dark:text-sky-400",
  failed: "text-destructive", unreachable: "text-destructive", skipped: "text-muted-foreground",
};

export function CellGlyph({ state, className }: { state: CellState; className?: string }) {
  return <span className={cn("inline-block w-4 text-center font-mono text-xs", CELL_TONE[state], className)} role="img" aria-label={state} title={state}>{glyph(state)}</span>;
}

const HEALTH_LABEL: Record<EnvHealthCode, string> = {
  ok: "Connected", unreachable: "Unreachable", "no-ansible": "Ansible missing", "no-repo": "Repo missing", degraded: "Degraded", disabled: "Disabled",
};

export function HealthBadge({ code }: { code: EnvHealthCode }) {
  const tone = code === "ok" ? "text-emerald-600 dark:text-emerald-400" : code === "disabled" ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400";
  return <span className={cn("text-xs font-medium", tone)}>{HEALTH_LABEL[code]}</span>;
}
