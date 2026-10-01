// The thread header's voice control: what this thread speaks, and its thread and project settings.
import { useEffect, useId, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SpeechIcon, VolumeHighIcon, VolumeMute01Icon } from "@hugeicons/core-free-icons";
import { useRealtime, useRpc, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { rpcContract } from "../contract.ts";
import type { Mode, ScopePatchInput, ScopeSetting, VoiceScopeState } from "../schemas.ts";
import { MODES } from "../page/listening-section.tsx";
import { StopSlider } from "../page/ui.tsx";
import { errorText } from "../util.ts";

type Scope = "thread" | "project";
type Children = "default" | "on" | "off";

const SOURCE: Record<VoiceScopeState["effective"]["modeFrom"], string> = {
  thread: "this thread",
  parent: "parent thread",
  project: "project",
  global: "global",
};

const CHILDREN: Record<Exclude<Children, "default">, string> = { on: "Voice", off: "Don't voice" };

export function childrenPatch(choice: Children): ScopePatchInput {
  return { voiceChildren: choice === "default" ? null : choice === "on" };
}

function modeLabel(mode: Mode): string {
  return MODES.find((m) => m.value === mode)?.label ?? mode;
}

/** The button's accessible name: the effective mode, or Off, and where it comes from. */
export function voiceLabel(state: VoiceScopeState): string {
  const { mode, voiced, modeFrom, isChild } = state.effective;
  if (voiced) return `Voice: ${modeLabel(mode)} (${SOURCE[modeFrom]})`;
  if (isChild && mode !== "quiet") return "Voice: Off (child threads are not voiced)";
  return `Voice: Off (${SOURCE[modeFrom]})`;
}

type View = { key: string; state: VoiceScopeState | null; error: string | null; loadFailed: boolean };
const blank = (key: string): View => ({ key, state: null, error: null, loadFailed: false });

export function VoiceScopeButton({ threadId, projectId }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const key = `${threadId}:${projectId}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [stored, setView] = useState<View>(() => blank(key));
  // Until the reset effect runs, never show another thread's state.
  const view = stored.key === key ? stored : blank(key);

  /** Apply an update only if the header still shows the thread it was made for. */
  const applyFor = (made: string, update: (v: View) => View) =>
    setView((v) => (currentKey.current === made && v.key === made ? update(v) : v));

  const load = () => {
    const made = key;
    rpc.call("getVoiceScope", { threadId, projectId }).then(
      (state) => applyFor(made, (v) => ({ ...v, state, error: null, loadFailed: false })),
      (cause) => applyFor(made, (v) => ({ ...v, error: errorText(cause), loadFailed: true })),
    );
  };

  useEffect(() => {
    setView(blank(key));
    load();
    // load reads the current thread and project; rerun only when they change.
  }, [threadId, projectId]);
  useRealtime("kokoro-scopes", () => load());
  useRealtime("kokoro-config", () => load());

  const save = (scope: Scope, patch: ScopePatchInput) => {
    const made = key;
    return rpc.call("setVoiceScope", { threadId, projectId, scope, patch }).then(
      (state) => applyFor(made, (v) => ({ ...v, state, error: null, loadFailed: false })),
      (cause) => applyFor(made, (v) => ({ ...v, error: errorText(cause) })),
    );
  };

  const { state, error, loadFailed } = view;
  if (!state && !loadFailed) {
    return (
      <Button variant="ghost" size="icon" className="relative size-7" aria-label="Voice" disabled>
        <HugeiconsIcon icon={SpeechIcon} className="size-4" />
      </Button>
    );
  }

  const label = state ? voiceLabel(state) : "Voice: unavailable";
  const overridden = state && (Object.keys(state.thread).length > 0 || Object.keys(state.project).length > 0);
  const icon = !state ? SpeechIcon : state.effective.voiced ? VolumeHighIcon : VolumeMute01Icon;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-7" aria-label={label}>
          <HugeiconsIcon icon={icon} className="size-4" />
          {overridden ? <span data-override className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="space-y-4">
        <p className="text-sm font-medium">{label.replace(/^Voice: /, "")}</p>
        {state ? (
          <>
            <ScopeSection title="This thread" setting={state.thread}
              defaultMode={state.inherited.voiced ? state.inherited.mode : "quiet"}
              defaultChildren={state.effective.isChild ? null : state.project.voiceChildren === true}
              onSave={(patch) => save("thread", patch)} />
            <ScopeSection title="This project" setting={state.project}
              defaultMode={state.globalMode} defaultChildren={false} onSave={(patch) => save("project", patch)} />
            <p className="text-xs text-muted-foreground">
              Mode changes reach an agent's instructions when its session restarts; Off and the mode's limit apply to the next reply.
            </p>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={load}>Retry</Button>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </PopoverContent>
    </Popover>
  );
}

function ScopeSection({ title, setting, defaultMode, defaultChildren, onSave }: {
  title: string;
  setting: ScopeSetting;
  /** What applies here with no mode set. */
  defaultMode: Mode;
  /** Whether child threads are voiced with nothing set; null when an ancestor thread decides. */
  defaultChildren: boolean | null;
  onSave: (patch: ScopePatchInput) => Promise<void>;
}) {
  const scope = title.toLowerCase();
  const childrenId = useId();
  const children: Children = setting.voiceChildren === undefined ? "default" : setting.voiceChildren ? "on" : "off";
  const defaultLabel = defaultChildren === null ? "Default" : `Default (${CHILDREN[defaultChildren ? "on" : "off"].toLowerCase()})`;
  return (
    <section className="space-y-2">
      <StopSlider label={`${title} mode`}
        caption={<h3 className="shrink-0 text-xs font-medium text-muted-foreground">{title}</h3>}
        value={setting.mode ?? defaultMode} options={MODES}
        inherited={setting.mode === undefined} onChange={(mode) => onSave({ mode })}
        action={setting.mode === undefined ? null : (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" aria-label={`Reset ${scope} mode`}
            onClick={() => void onSave({ mode: null })}>Reset</Button>
        )} />
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={childrenId} className="text-xs font-normal">Child threads</Label>
        <Select value={children} onValueChange={(v) => void onSave(childrenPatch(v as Children))}>
          <SelectTrigger id={childrenId} aria-label={`${title} child threads`} className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{defaultLabel}</SelectItem>
            <SelectItem value="on">{CHILDREN.on}</SelectItem>
            <SelectItem value="off">{CHILDREN.off}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}
