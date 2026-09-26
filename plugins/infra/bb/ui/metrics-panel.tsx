// Range toggle + the four resource charts for a host or guest.
import { cn } from "@/lib/utils";
import type { MetricRange } from "../schemas.ts";
import { MetricChart } from "./charts.tsx";
import { useInfraQuery } from "./hooks.ts";

const RANGES: { id: MetricRange; label: string }[] = [{ id: "hour", label: "Hour" }, { id: "day", label: "Day" }, { id: "week", label: "Week" }];

export function MetricsPanel({ target, range, onRange, compact }: { target: string; range: MetricRange; onRange(r: MetricRange): void; compact?: boolean }) {
  const q = useInfraQuery("metrics", { target, range }, { refreshOn: [], intervalMs: 60_000 });
  const points = q.data?.found ? q.data.series.points : [];
  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => onRange(r.id)} className={cn("rounded px-2.5 py-1 text-xs", range === r.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}>{r.label}</button>
        ))}
      </div>
      {q.error ? <p className="text-sm text-destructive">{q.error}</p> : null}
      <div className={cn("grid gap-4", !compact && "lg:grid-cols-2")}>
        <MetricChart points={points} kind="cpu" />
        <MetricChart points={points} kind="mem" />
        <MetricChart points={points} kind="net" />
        <MetricChart points={points} kind="disk" />
      </div>
    </div>
  );
}
