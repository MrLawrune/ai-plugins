// The thread header's voice control: what this thread speaks, and its thread and project settings.
import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SpeechIcon, VolumeHighIcon, VolumeMute01Icon } from "@hugeicons/core-free-icons";
import { useRealtime, useRpc, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { KokoroConfig, rpcContract, ScopePatchInput, ScopeSetting, VoiceScopeState } from "../schemas.ts";
import { MODES } from "../page/listening-section.tsx";
import { ChoiceGroup } from "../page/ui.tsx";
import { errorText } from "../util.ts";

type Scope = "thread" | "project";
type Children = "default" | "on" | "off";

const SOURCE: Record<VoiceScopeState["effective"]["modeFrom"], string> = {
  thread: "this thread",
  parent: "parent thread",
  project: "project",
  global: "global",
};

const CHILDREN: { value: Children; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "on", label: "Voice" },
  { value: "off", label: "Don't voice" },
];

function modeLabel(mode: KokoroConfig["mode"]): string {
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
    rpc.call("setVoiceScope", { threadId, projectId, scope, patch }).then(
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
              defaultMode={state.inherited.mode} onSave={(patch) => save("thread", patch)} />
            <ScopeSection title="This project" setting={state.project}
              defaultMode={state.globalMode} onSave={(patch) => save("project", patch)} />
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

function ScopeSection({ title, setting, defaultMode, onSave }: {
  title: string;
  setting: ScopeSetting;
  defaultMode: KokoroConfig["mode"];
  onSave: (patch: ScopePatchInput) => void;
}) {
  const modes = [{ value: "default", label: `Default (${modeLabel(defaultMode)})` }, ...MODES];
  const children: Children = setting.voiceChildren === undefined ? "default" : setting.voiceChildren ? "on" : "off";
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <p className="text-xs">Mode</p>
      <ChoiceGroup<string> label={`${title} mode`} value={setting.mode ?? "default"} options={modes}
        onChange={(v) => onSave({ mode: v === "default" ? null : (v as KokoroConfig["mode"]) })} />
      <p className="text-xs">Child threads</p>
      <ChoiceGroup<Children> label={`${title} child threads`} value={children} options={CHILDREN}
        onChange={(v) => onSave({ voiceChildren: v === "default" ? null : v === "on" })} />
    </section>
  );
}
