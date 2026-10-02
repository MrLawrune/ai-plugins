import { useCallback } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { rpcContract } from "../contract.ts";
import { HistorySection } from "./history-section.tsx";
import { ListeningSection } from "./listening-section.tsx";
import { SoundsSection } from "./sounds-section.tsx";
import { anyEngineUp, localEngineUp, useConfig, useLoaded, usePrefs, useStatus } from "./state.ts";
import { statusLine } from "./status.ts";
import { SaveIndicator, StatusDot } from "./ui.tsx";
import { VoiceSection } from "./voice-section.tsx";
import { WhereSection } from "./where-section.tsx";

const SETTINGS_PATH = "Settings › Plugins › Kokoro TTS";

export function KokoroPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const status = useStatus();
  // listVoices falls back to the backup, so any engine answering is enough.
  const up = anyEngineUp(status);
  const { data, error, reload, patch, dismissNote, save } = useConfig(localEngineUp(status));
  const { prefs, setPrefs } = usePrefs();
  const voices = useLoaded(useCallback(() => rpc.call("listVoices"), [rpc]), up);
  const line = statusLine(status);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        {!up ? (
          <div className="flex items-start gap-2 rounded-md border border-border px-3 py-2.5 text-sm">
            <StatusDot tone={line.tone} />
            <div className="min-w-0">
              <p className="font-medium">{line.text}</p>
              <p className="text-xs text-muted-foreground">
                Speech plays once an engine is running. Setup and engine options are in {SETTINGS_PATH}.
              </p>
            </div>
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
            Couldn't load settings: {error}
            <Button variant="outline" size="sm" onClick={() => void reload()}>Retry</Button>
          </div>
        ) : null}
        {data?.note ? (
          <div role="status" className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-sm">
            <p className="min-w-0">{data.note}</p>
            <Button variant="ghost" size="sm" onClick={() => void dismissNote()}>Dismiss</Button>
          </div>
        ) : null}
        {data && prefs ? (
          <div className="divide-y divide-border">
            <ListeningSection config={data.config} patch={patch} />
            <VoiceSection config={data.config} voices={voices.value?.voices ?? []} patch={patch} />
            <SoundsSection config={data.config} patch={patch} />
            <HistorySection config={data.config} patch={patch} />
            <WhereSection
              prefs={prefs}
              setPrefs={setPrefs}
              config={data.config}
              patch={patch}
              clients={status?.clients ?? []}
              pauseSupported={data.pause_other_audio_supported}
            />
          </div>
        ) : !error ? (
          <p className="text-sm text-muted-foreground">Loading settings…</p>
        ) : null}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <span>Changes save automatically. Engine options: {SETTINGS_PATH}.</span>
          <SaveIndicator state={save} />
        </footer>
      </div>
    </div>
  );
}
