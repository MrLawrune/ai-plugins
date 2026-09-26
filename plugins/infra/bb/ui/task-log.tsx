// Paged Proxmox task log viewer.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useInfraRpc } from "./hooks.ts";

const PAGE = 500;

export function TaskLogDialog({ target, upid, title, onClose }: { target: string; upid: string; title: string; onClose(): void }) {
  const call = useInfraRpc();
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = (start: number) => {
    call("taskLog", { target, upid, start, limit: PAGE }).then(
      (r) => { if (!r.found) { setError("This task's log is not available."); return; } setLines((l) => [...l, ...r.lines]); setDone(r.lines.length < PAGE); },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(0), [target, upid]);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-2 text-xs">{lines.join("\n") || (error ? "" : "Loading…")}</pre>
        {!done && lines.length ? <Button variant="outline" size="sm" onClick={() => load(lines.length)}>Load more</Button> : null}
      </DialogContent>
    </Dialog>
  );
}
