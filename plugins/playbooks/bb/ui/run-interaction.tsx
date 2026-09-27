// Composer interaction for agent-initiated runs (`bb playbooks run`): shows the run form and returns the spec.
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import { fromPayload } from "./run-form-model.ts";
import { RunForm } from "./run-form.tsx";

export function RunInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const [busy, setBusy] = useState(false);
  const data = fromPayload(interaction.payload);
  if (!data) {
    return (
      <div className="space-y-2 rounded-lg border border-destructive/50 bg-card p-3 text-xs text-destructive">
        This run request is malformed and cannot be shown.
        <div><button type="button" className="underline" onClick={() => void cancel()}>Dismiss</button></div>
      </div>
    );
  }
  return (
    <RunForm
      env={data.env} playbook={data.playbook} summaryLine={data.summaryLine} initial={data.spec} inventories={data.inventories}
      credRefs={data.credRefs} policy={data.policy} busy={busy}
      onCancel={() => { setBusy(true); cancel().catch((e: unknown) => { setBusy(false); toast.error(e instanceof Error ? e.message : String(e)); }); }}
      onSubmit={(spec, typed) => {
        setBusy(true);
        submit({ ...spec, ...(typed !== undefined ? { typed } : {}) } as unknown as JsonValue)
          .catch((e: unknown) => { setBusy(false); toast.error(e instanceof Error ? e.message : String(e)); });
      }}
    />
  );
}
