// "Ask agent": opens BB's new-thread composer with a prompt built from live context.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { ASK_MENU, labelFor, type TargetKind } from "./ask-model.ts";
import { useInfraRpc } from "./hooks.ts";

export function AskAgentMenu({ target, kind, size = "sm" }: { target: string; kind: TargetKind; size?: "sm" | "icon" }) {
  const call = useInfraRpc();
  const nav = useBbNavigate();
  const open = async (intent: (typeof ASK_MENU)[number]["intent"]) => {
    try {
      const r = await call("askPrompt", { target, intent });
      if (!r.found) { toast.error(`${target} is no longer in the inventory`); return; }
      nav.toCompose({ initialPrompt: r.prompt, focusPrompt: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={size === "icon" ? "icon" : "sm"} aria-label="Ask an agent" className="gap-1.5">
          <Icon name="Bot" className="size-4" />
          {size === "icon" ? null : "Ask agent"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ASK_MENU.map((m) => <DropdownMenuItem key={m.intent} onSelect={() => void open(m.intent)}>{labelFor(m.intent, kind)}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
