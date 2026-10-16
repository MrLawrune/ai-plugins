// The Dictation nav panel: profiles, then the settings of the profile being edited, then history.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { rpcContract } from "../contract.ts";
import { CommandsSection, ContinuousSection, DictationSection, VocabularySection } from "./dictation-sections.tsx";
import { errorText } from "./error-text.ts";
import { HistorySection } from "./history-section.tsx";
import { useProfilePrefs, useRoster } from "./panel-state.ts";
import { ProfilesSection } from "./profiles-section.tsx";
import { useHealth } from "./state.ts";
import { healthLine } from "./status.ts";
import { SaveIndicator, StatusDot } from "./ui.tsx";

// Plain text on purpose: the plugin SDK can open a plugin panel (useBbNavigate) but not a plugin's settings page.
const SETTINGS_PATH = "Settings › Plugins › Parakeet STT › Server";

export function ParakeetHeader() {
  const line = healthLine(useHealth());
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <StatusDot tone={line.tone} />
      <span className="hidden sm:inline">{line.text}</span>
    </span>
  );
}

/** The 0.1.0 migration note, until dismissed. */
function useNote() {
  const rpc = useRpc<typeof rpcContract>();
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("getNote").then((r) => { if (live) setNote(r.note); }, () => {});
    return () => { live = false; };
  }, [rpc]);
  const dismiss = async () => {
    const shown = note;
    setNote(null);
    try {
      await rpc.call("dismissNote");
    } catch (cause) {
      // The server still has the note, so keep showing it.
      setNote(shown);
      toast.error(errorText(cause));
    }
  };
  return { note, dismiss };
}

export function ParakeetPanel() {
  const health = useHealth();
  const roster = useRoster();
  const { note, dismiss } = useNote();
  const [picked, setPicked] = useState<string | null>(null);
  const editing = picked ?? roster.me?.profileId ?? null;
  const { load } = roster;
  useEffect(() => { void load(); }, [load]);
  const { prefs, patch, save, error, retry } = useProfilePrefs(editing, roster.me);
  const profileName = roster.profiles.find((p) => p.id === editing)?.name ?? "";
  const failure = roster.error ?? error;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        {health?.configured === false ? (
          <div className="flex items-start gap-2 rounded-md border border-border px-3 py-2.5 text-sm">
            <StatusDot tone="warn" />
            <div className="min-w-0">
              <p className="font-medium">Set up the server to start dictating.</p>
              <p className="text-xs text-muted-foreground">Enter the server URL in {SETTINGS_PATH}.</p>
            </div>
          </div>
        ) : null}
        {failure ? (
          <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
            Couldn't load settings: {failure}
            <Button variant="outline" size="sm" onClick={() => (roster.error ? void load() : retry())}>Retry</Button>
          </div>
        ) : null}
        {note ? (
          <div role="status" className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-sm">
            <p className="min-w-0">{note}</p>
            <Button variant="ghost" size="sm" onClick={() => void dismiss()}>Dismiss</Button>
          </div>
        ) : null}
        {roster.me && editing ? (
          <div className="divide-y divide-border">
            <ProfilesSection me={roster.me} devices={roster.devices} profiles={roster.profiles} editing={editing} onEdit={setPicked} api={roster.api} />
            {prefs ? (
              <>
                <DictationSection prefs={prefs} patch={patch} profileName={profileName} />
                <ContinuousSection prefs={prefs} patch={patch} profileName={profileName} />
                <CommandsSection prefs={prefs} patch={patch} profileName={profileName} />
                <VocabularySection prefs={prefs} patch={patch} />
              </>
            ) : null}
            {/* Outside the prefs gate: history is not per profile, so a profile switch keeps the list. */}
            <HistorySection prefs={prefs} patch={patch} />
          </div>
        ) : !failure ? (
          <p className="text-sm text-muted-foreground">Loading settings…</p>
        ) : null}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <span>Changes save automatically.</span>
          <SaveIndicator state={save} />
        </footer>
      </div>
    </div>
  );
}
