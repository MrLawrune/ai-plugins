// ⋯ menu on a playbook, play, step, or run cell, and the shared dispatch actions behind it: Add to chat inserts a
// @playbooks pill (or seeds the compose screen when no composer is reachable), New thread… opens the dialog, and
// Investigate spawns the read-only debug thread and jumps to it.
import { useState, type ReactNode } from "react";
import { useBbContext, useBbNavigate, useComposer, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { investigateToast } from "./dispatch-model.ts";
import { usePlaybooksRpc } from "./hooks.ts";
import { NewThreadDialog, type NewThreadRequest } from "./new-thread-dialog.tsx";

export const MENTION_PROVIDER = "playbooks";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type RunScope = { host?: string; node?: string };
export interface DispatchHandlers {
  addToChat(target: string, label?: string, extraText?: string): void;
  newThread(target: string, opts?: { runId?: string; label?: string }): void;
  investigate(runId: string, scope: RunScope): void;
  /** Render once per mount site; hosts the New thread dialog. */
  dialog: ReactNode;
}

/** `useComposer` is the only SDK hook that can be missing a scope; treat a throw as "no composer here". */
function useComposerSafe(): PluginComposerApi | null {
  try {
    return useComposer();
  } catch {
    return null;
  }
}

export function useDispatch(): DispatchHandlers {
  const composer = useComposerSafe();
  const nav = useBbNavigate();
  const { projectId, threadId } = useBbContext();
  const call = usePlaybooksRpc();
  const [request, setRequest] = useState<NewThreadRequest | null>(null);

  const addToChat = (target: string, label = target, extraText?: string) => {
    if (composer) {
      try {
        composer.insertMention({ provider: MENTION_PROVIDER, id: target, label });
        if (extraText) composer.updateText((t) => `${t}${t.endsWith(" ") || t === "" ? "" : " "}${extraText}`);
        composer.focus();
        return;
      } catch (e) {
        toast.error(`Could not add to chat: ${errorText(e)}`);
        return;
      }
    }
    void call("dispatch.prompt", { target, instruction: extraText ?? "" }).then(
      (r) => nav.toCompose({ initialPrompt: r.prompt, focusPrompt: true }),
      (e: unknown) => toast.error(`Could not build the context: ${errorText(e)}`),
    );
  };

  const investigate = (runId: string, scope: RunScope) => {
    void call("run.investigate", { runId, host: scope.host, node: scope.node, threadId: threadId ?? undefined, projectId: projectId ?? undefined }).then(
      (r) => {
        toast.success(investigateToast(r.permissionMode), { action: { label: "Open", onClick: () => nav.toThread(r.threadId) } });
        nav.toThread(r.threadId);
      },
      (e: unknown) => toast.error(`Could not start the investigation: ${errorText(e)}`),
    );
  };

  return {
    addToChat,
    newThread: (target, opts) => setRequest({ target, runId: opts?.runId ?? null, label: opts?.label ?? target }),
    investigate,
    dialog: request ? <NewThreadDialog request={request} onClose={() => setRequest(null)} /> : null,
  };
}

export interface DispatchMenuProps {
  target: string;
  /** Pill text for Add to chat; defaults to the target ref. */
  label?: string;
  runRef?: string;
  failed?: boolean;
  onAddToChat(): void;
  onNewThread(): void;
  onInvestigate?(): void;
}

export function DispatchMenu({ target, runRef, failed, onAddToChat, onNewThread, onInvestigate }: DispatchMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-6" aria-label={`Actions for ${runRef ?? target}`} onClick={(e) => e.stopPropagation()}>
          <span aria-hidden className="text-base leading-none">⋯</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onAddToChat}>Add to chat</DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewThread}>New thread…</DropdownMenuItem>
        {failed && onInvestigate ? <DropdownMenuItem onSelect={onInvestigate}>Investigate failure</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
