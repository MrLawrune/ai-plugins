// Opens the Playbooks thread panel; toasts when the host declines.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

export type PanelParams = { target: string; view?: "list" | "graph"; run?: boolean } | { runId: string };

export function useOpenPanel(): (params: PanelParams, title: string) => void {
  const nav = useBbNavigate();
  return (params, title) => {
    if (!nav.openThreadPanel({ actionId: "playbooks", title, params })) toast.error("Could not open the Playbooks panel here");
  };
}
