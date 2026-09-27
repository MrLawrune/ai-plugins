// New thread… dialog (spec §4.5): the target line, an optional instruction, the size of the context that will be
// sent, then Start (server-side spawn in the current project) or Edit first (the compose screen, prefilled).
import { useId, useState } from "react";
import { useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { contextSize, promptBytes, withInstruction } from "./dispatch-model.ts";
import { usePlaybooksQuery, usePlaybooksRpc } from "./hooks.ts";

export interface NewThreadRequest { target: string; runId: string | null; label: string }
const INSTRUCTION_MAX = 4000;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function NewThreadDialog({ request, onClose }: { request: NewThreadRequest; onClose(): void }) {
  const { target, runId, label } = request;
  const { projectId, threadId } = useBbContext();
  const nav = useBbNavigate();
  const call = usePlaybooksRpc();
  const id = useId();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"start" | "edit" | null>(null);
  const base = usePlaybooksQuery("dispatch.prompt", { target, runId: runId ?? undefined, instruction: "" }, { refreshOn: [] });
  const size = base.data ? contextSize(promptBytes(withInstruction(base.data.prompt, instruction))) : null;
  const args = { target, runId: runId ?? undefined, instruction: instruction.trim() };

  const start = async () => {
    if (!projectId) { toast.error("Open a project first: a new thread needs one"); return; }
    setBusy("start");
    try {
      const r = await call("dispatch.spawn", { ...args, projectId, threadId: threadId ?? undefined });
      onClose();
      toast.success("Started a new thread", { action: { label: "Open", onClick: () => nav.toThread(r.threadId) } });
      nav.toThread(r.threadId);
    } catch (e) {
      toast.error(`Could not start the thread: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const editFirst = async () => {
    setBusy("edit");
    try {
      const r = await call("dispatch.prompt", args);
      onClose();
      nav.toCompose({ initialPrompt: r.prompt, focusPrompt: true });
    } catch (e) {
      toast.error(`Could not build the prompt: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New thread from {label}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{target}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-instruction`}>Instruction (optional)</Label>
          <Textarea id={`${id}-instruction`} rows={3} maxLength={INSTRUCTION_MAX} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="make this step idempotent and notify the handler only on change" autoFocus />
        </div>
        <div className="text-xs text-muted-foreground">
          {base.error ? <span className="text-destructive">Context unavailable: {base.error}</span>
            : size ? <>Context that will be included ({size}): env, rules, file, step YAML, play vars{runId ? ", last run" : ""}</>
            : "Measuring the context…"}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy !== null} onClick={onClose}>Cancel</Button>
          <Button variant="outline" disabled={busy !== null || !!base.error} onClick={() => void editFirst()}>{busy === "edit" ? "Opening…" : "Edit first"}</Button>
          <Button disabled={busy !== null || !!base.error} onClick={() => void start()}>{busy === "start" ? "Starting…" : "Start"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
