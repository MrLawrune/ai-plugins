// Hand-rolled SVG charts. One y-axis per chart; series colors are the validated categorical
// slots 1-2 (blue, orange) with dark-mode steps; text stays in host ink tokens.
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import type { MetricPoint } from "../schemas.ts";
import { bytes } from "./format.ts";

const SERIES = [
  { stroke: "stroke-[#2a78d6] dark:stroke-[#3987e5]", fill: "fill-[#2a78d6] dark:fill-[#3987e5]", swatch: "bg-[#2a78d6] dark:bg-[#3987e5]" },
  { stroke: "stroke-[#eb6834] dark:stroke-[#d95926]", fill: "fill-[#eb6834] dark:fill-[#d95926]", swatch: "bg-[#eb6834] dark:bg-[#d95926]" },
] as const;

export type ChartKind = "cpu" | "mem" | "net" | "disk";

interface SeriesDef { label: string; value: (p: MetricPoint) => number | null }
interface ChartDef { title: string; series: SeriesDef[]; format: (v: number) => string; max?: (points: MetricPoint[]) => number; area: boolean }

const perSec = (v: number) => `${bytes(v)}/s`;
const DEFS: Record<ChartKind, ChartDef> = {
  cpu: { title: "CPU", series: [{ label: "CPU", value: (p) => (p.cpu === null ? null : p.cpu * 100) }], format: (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`, max: () => 100, area: true },
  mem: { title: "Memory", series: [{ label: "Used", value: (p) => p.mem }], format: bytes, max: (ps) => Math.max(0, ...ps.map((p) => p.maxmem ?? 0)), area: true },
  net: { title: "Network", series: [{ label: "In", value: (p) => p.netin }, { label: "Out", value: (p) => p.netout }], format: perSec, area: false },
  disk: { title: "Disk I/O", series: [{ label: "Read", value: (p) => p.diskread }, { label: "Write", value: (p) => p.diskwrite }], format: perSec, area: false },
};

const H = 140;

/** Chart width in CSS pixels, so the SVG is drawn 1:1 and text is never stretched. */
function useWidth(el: HTMLElement | null, fallback = 480): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => { if (e && e.contentRect.width > 0) setW(Math.round(e.contentRect.width)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}
const PAD = { l: 68, r: 8, t: 8, b: 18 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= v) ?? v;
}

const timeLabel = (t: number, spanMs: number) =>
  new Date(t).toLocaleString(undefined, spanMs > 36 * 3600_000 ? { weekday: "short", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

export function MetricChart({ points, kind, className }: { points: MetricPoint[]; kind: ChartKind; className?: string }) {
  const def = DEFS[kind];
  const clipId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const W = useWidth(box);
  const [hover, setHover] = useState<number | null>(null);
  const data = useMemo(() => points.filter((p) => def.series.some((s) => s.value(p) !== null)), [points, def]);

  if (data.length < 2) return <div className={cn("flex h-[140px] items-center justify-center rounded-md border text-xs text-muted-foreground", className)}>No {def.title.toLowerCase()} data for this range</div>;

  const t0 = data[0]!.t;
  const t1 = data.at(-1)!.t;
  const span = Math.max(1, t1 - t0);
  const observed = Math.max(0, ...data.flatMap((p) => def.series.map((s) => s.value(p) ?? 0)));
  const yMax = def.max ? Math.max(def.max(data), observed) || niceMax(observed) : niceMax(observed * 1.1);
  const x = (t: number) => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / yMax) * (H - PAD.t - PAD.b);
  const path = (s: SeriesDef) => data.map((p, i) => { const v = s.value(p); return v === null ? "" : `${i && data[i - 1] && s.value(data[i - 1]!) !== null ? "L" : "M"}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`; }).join("");
  const area = (s: SeriesDef) => `${path(s)}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;
  const ticks = [0, 0.5, 1].map((f) => f * yMax);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const t = t0 + ((e.clientX - r.left) / r.width * W - PAD.l) / (W - PAD.l - PAD.r) * span;
    let best = 0;
    for (let i = 1; i < data.length; i++) if (Math.abs(data[i]!.t - t) < Math.abs(data[best]!.t - t)) best = i;
    setHover(best);
  };
  const hp = hover === null ? null : data[hover]!;
  const latest = data.at(-1)!;

  return (
    <figure className={cn("space-y-1.5", className)}>
      <figcaption className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{def.title}</span>
        {def.series.length > 1 ? (
          <span className="flex gap-3 text-muted-foreground">
            {def.series.map((s, i) => (
              <span key={s.label} className="inline-flex items-center gap-1"><span className={cn("size-2 rounded-sm", SERIES[i]!.swatch)} />{s.label} <span className="tabular-nums text-foreground">{def.format(s.value(latest) ?? 0)}</span></span>
            ))}
          </span>
        ) : <span className="tabular-nums text-muted-foreground">now <span className="text-foreground">{def.format(def.series[0]!.value(latest) ?? 0)}</span></span>}
      </figcaption>
      <div className="relative" ref={setBox}>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block touch-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`${def.title} over time`}>
          <defs><clipPath id={clipId}><rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} /></clipPath></defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <text x={PAD.l - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px]">{def.format(v)}</text>
            </g>
          ))}
          <text x={PAD.l} y={H - 4} className="fill-muted-foreground text-[10px]">{timeLabel(t0, span)}</text>
          <text x={W - PAD.r} y={H - 4} textAnchor="end" className="fill-muted-foreground text-[10px]">{timeLabel(t1, span)}</text>
          <g clipPath={`url(#${clipId})`}>
            {def.series.map((s, i) => (
              <g key={s.label}>
                {def.area ? <path d={area(s)} className={cn(SERIES[i]!.fill, "opacity-15")} /> : null}
                <path d={path(s)} fill="none" className={SERIES[i]!.stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </g>
            ))}
          </g>
          {hp ? (
            <g>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={H - PAD.b} className="stroke-muted-foreground" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              {def.series.map((s, i) => { const v = s.value(hp); return v === null ? null : <circle key={s.label} cx={x(hp.t)} cy={y(v)} r={4} className={cn(SERIES[i]!.fill, "stroke-card")} strokeWidth={2} vectorEffect="non-scaling-stroke" />; })}
            </g>
          ) : null}
        </svg>
        {hp ? (
          <div className="pointer-events-none absolute top-1 rounded-md border bg-popover px-2 py-1 text-xs shadow-sm" style={{ left: `${Math.min(70, (x(hp.t) / W) * 100)}%` }}>
            <div className="text-muted-foreground">{new Date(hp.t).toLocaleString()}</div>
            {def.series.map((s, i) => (
              <div key={s.label} className="flex items-center gap-1.5"><span className={cn("size-2 rounded-sm", SERIES[i]!.swatch)} />{s.label} <span className="tabular-nums">{def.format(s.value(hp) ?? 0)}</span></div>
            ))}
          </div>
        ) : null}
      </div>
      <table className="sr-only">
        <caption>{def.title}</caption>
        <thead><tr><th>Time</th>{def.series.map((s) => <th key={s.label}>{s.label}</th>)}</tr></thead>
        <tbody>{data.slice(-12).map((p) => <tr key={p.t}><td>{new Date(p.t).toLocaleString()}</td>{def.series.map((s) => <td key={s.label}>{def.format(s.value(p) ?? 0)}</td>)}</tr>)}</tbody>
      </table>
    </figure>
  );
}

/** Tiny trend line for cards; single series, no axes. */
export function Sparkline({ values, className, label }: { values: number[]; className?: string; label: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1e-9);
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * 100).toFixed(1)},${(22 - (v / max) * 20).toFixed(1)}`).join("");
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className={cn("h-6 w-full", className)} role="img" aria-label={label}>
      <path d={d} fill="none" className={SERIES[0].stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
