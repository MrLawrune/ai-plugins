// L2 for one matrix cell (host × task): message, result excerpt, diff, duration, plus the investigate action.
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { usePlaybooksQuery } from "./hooks.ts";

const EXCERPT = 800;
const clip = (s: string) => (s.length > EXCERPT ? `${s.slice(0, EXCERPT)}…` : s);

export function CellDetail({ runId, host, node, playIndex, taskIndex, onInvestigate }: { runId: string; host: string; node: string; playIndex?: number; taskIndex?: number; onInvestigate?: () => void }) {
  const q = usePlaybooksQuery("run.cell", { runId, host, node, ...(playIndex !== undefined && taskIndex !== undefined ? { playIndex, taskIndex } : {}) }, { refreshOn: [] });
  if (q.error) return <div className="text-xs text-destructive">Could not load {host}: {q.error}</div>;
  if (!q.data) return <div className="h-10 animate-pulse rounded-md border bg-muted/40" />;
  const c = q.data;
  const empty = !c.msg && !c.ignored && !c.res && !c.diff && !c.stdout;
  return (
    <div className="space-y-1.5 rounded-md border bg-card px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium">{host}</span>
        {c.durationMs !== null ? <span className="text-muted-foreground">{(c.durationMs / 1000).toFixed(1)}s</span> : null}
        {onInvestigate ? <Button variant="ghost" size="sm" className="ml-auto" onClick={onInvestigate}>Investigate ▸</Button> : null}
      </div>
      {c.msg || c.ignored ? <div className="whitespace-pre-wrap break-words">{c.msg}{c.ignored ? <span className="text-muted-foreground"> (ignored)</span> : null}</div> : null}
      {c.res ? <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-1.5 font-mono">{clip(c.res)}</pre> : null}
      {c.stdout ? <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-1.5 font-mono">{clip(c.stdout)}</pre> : null}
      {c.diff ? <Diff patch={c.diff} path={node} /> : null}
      {empty ? <div className="text-muted-foreground">No output recorded for this step.</div> : null}
    </div>
  );
}
