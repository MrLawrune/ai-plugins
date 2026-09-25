import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setDictationPrefs } from "../dictation-prefs.ts";
import { SHORTCUTS, type HealthResult, type HistoryEntry, type Prefs, type rpcContract } from "../schemas.ts";
import { errorText, Row, Section, SliderRow, SwitchRow } from "./ui.tsx";

function statusText(h: HealthResult | null): string {
  if (!h) return "Checking…";
  if (!h.configured) return "Not configured";
  if (h.up) return `Ready — ${h.model} (server ${h.version})`;
  return `Unavailable — ${h.error ?? "unknown error"}`;
}

export function ParakeetPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [words, setWords] = useState("");
  const [starts, setStarts] = useState("");

  const refresh = useCallback(async () => {
    const [p, h, hist] = await Promise.all([rpc.call("getPrefs"), rpc.call("health"), rpc.call("listHistory")]);
    setPrefs(p);
    setDictationPrefs(p);
    setHealth(h);
    setHistory(hist.entries);
    setWords(p.customWords.join(", "));
    setStarts(p.startPhrases.join(", "));
  }, [rpc]);
  useEffect(() => { void refresh().catch((e) => toast.error(errorText(e))); }, [refresh]);

  const patch = async (p: Partial<Prefs>) => {
    try {
      const next = await rpc.call("setPrefs", p);
      setPrefs(next);
      setDictationPrefs(next);
      setWords(next.customWords.join(", "));
      setStarts(next.startPhrases.join(", "));
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  if (!prefs) return null;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto box-border flex w-full max-w-2xl flex-col gap-6 px-4 pb-6 pt-3 md:px-6 md:pt-4">
      <Section
        title="Server"
        description="Set the server URL and API key in Settings → Installed plugins → Parakeet STT."
        actions={<Button size="sm" variant="outline" onClick={() => void refresh().catch((e) => toast.error(errorText(e)))}>Check</Button>}
      >
        <Row label="Status"><span className="text-sm">{statusText(health)}</span></Row>
        {health?.lastLatencyMs != null && <Row label="Last transcription"><span className="text-sm">{health.lastLatencyMs} ms</span></Row>}
      </Section>

      <Section title="Dictation">
        <Row label="Shortcut" hint="Works while bb has focus. Esc cancels a recording." htmlFor="shortcut">
          <select
            id="shortcut"
            className="rounded-md border bg-transparent px-2 py-1 text-sm"
            value={prefs.shortcut}
            onChange={(e) => void patch({ shortcut: e.target.value as Prefs["shortcut"] })}
          >
            {SHORTCUTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Row>
        <SwitchRow id="hold" label="Hold to talk" hint="Record only while the shortcut is held" checked={prefs.holdToTalk} onChange={(v) => void patch({ holdToTalk: v })} />
        <SwitchRow id="submit" label="Auto-submit" hint="Send the message after a one-shot dictation" checked={prefs.autoSubmit} onChange={(v) => void patch({ autoSubmit: v })} />
        <SwitchRow id="space" label="Trailing space" checked={prefs.trailingSpace} onChange={(v) => void patch({ trailingSpace: v })} />
        <SwitchRow id="sounds" label="Sound cues" checked={prefs.soundCues} onChange={(v) => void patch({ soundCues: v })} />
      </Section>

      <Section title="Continuous dictation" description="Tap the mic for your default mode; press and hold for one-shot push-to-talk.">
        <Row label="Default mode" htmlFor="mode">
          <select id="mode" className="rounded-md border bg-transparent px-2 py-1 text-sm" value={prefs.mode}
            onChange={(e) => void patch({ mode: e.target.value as Prefs["mode"] })}>
            <option value="continuous">Continuous (commit at each pause)</option>
            <option value="oneshot">One-shot (transcribe on stop)</option>
          </select>
        </Row>
        <SwitchRow id="preview" label="Live preview" hint="Show the phrase in progress, dimmed" checked={prefs.livePreview} onChange={(v) => void patch({ livePreview: v })} />
        <SliderRow id="pause" label="Pause before commit" value={prefs.pauseMs} min={300} max={1500} step={50} format={(v) => `${v} ms`} onChange={(v) => void patch({ pauseMs: v })} />
        <SwitchRow id="silence" label="End on silence" checked={prefs.endOnSilence} onChange={(v) => void patch({ endOnSilence: v })} />
        {prefs.endOnSilence && (
          <SliderRow id="silence-s" label="Silence timeout" value={prefs.silenceTimeoutS} min={3} max={60} step={1} format={(v) => `${v} s`} onChange={(v) => void patch({ silenceTimeoutS: v })} />
        )}
        <SwitchRow id="commands" label="Voice commands" hint="Send and stop count at the end of a sentence; clear and start phrases count anywhere. Separate alternatives with commas (e.g. send it, sunday)." checked={prefs.voiceCommands} onChange={(v) => void patch({ voiceCommands: v })} />
        {prefs.voiceCommands && (
          <>
            <Row label="Send phrase" htmlFor="send-phrase"><Input id="send-phrase" defaultValue={prefs.sendPhrase} onBlur={(e) => void patch({ sendPhrase: e.target.value })} /></Row>
            <Row label="Stop phrase" htmlFor="stop-phrase"><Input id="stop-phrase" defaultValue={prefs.stopPhrase} onBlur={(e) => void patch({ stopPhrase: e.target.value })} /></Row>
            <Row label="Clear phrase" hint="Empties the message box and keeps listening" htmlFor="clear-phrase"><Input id="clear-phrase" defaultValue={prefs.clearPhrase} onBlur={(e) => void patch({ clearPhrase: e.target.value })} /></Row>
            <SwitchRow id="wait-start" label="Wait for a start phrase" hint="The mic ignores speech until you say a start phrase; the send phrase sends and goes back to waiting" checked={prefs.waitForStart} onChange={(v) => void patch({ waitForStart: v })} />
            {prefs.waitForStart && (
              <Row label="Start phrases" hint="Comma-separated; anything said after one is kept. The banner shows what it heard while waiting." htmlFor="start-phrases">
                <Input id="start-phrases" value={starts} onChange={(e) => setStarts(e.target.value)} onBlur={() => void patch({ startPhrases: starts.split(",") })} />
              </Row>
            )}
          </>
        )}
        <SwitchRow id="hidden" label="Keep listening when the screen is off" hint="Off: locking the phone ends dictation" checked={prefs.keepListeningHidden} onChange={(v) => void patch({ keepListeningHidden: v })} />
        <SwitchRow id="floating" label="Floating mic on phones" hint="Dictate without opening the keyboard" checked={prefs.floatingMic} onChange={(v) => void patch({ floatingMic: v })} />
        <SwitchRow id="compact" label="Show more lines in the collapsed composer" hint="Phones: wrap the draft instead of cutting it off" checked={prefs.expandCompactDraft} onChange={(v) => void patch({ expandCompactDraft: v })} />
        <SwitchRow id="native" label="Hide bb's voice button" hint="Keep one mic in the composer" checked={prefs.hideNativeMic} onChange={(v) => void patch({ hideNativeMic: v })} />
      </Section>

      <Section title="Vocabulary">
        <Row label="Custom words" hint="Comma-separated; fixes spelling and case (e.g. tmux, CLAUDE.md)" htmlFor="words">
          <Input id="words" value={words} onChange={(e) => setWords(e.target.value)} onBlur={() => void patch({ customWords: words.split(",") })} />
        </Row>
        <SwitchRow id="fillers" label="Remove filler words" hint="um, uh, er…" checked={prefs.removeFillers} onChange={(v) => void patch({ removeFillers: v })} />
        <SliderRow
          id="threshold"
          label="Correction strength"
          hint="Higher corrects more aggressively"
          value={prefs.correctionThreshold}
          min={0}
          max={0.5}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => void patch({ correctionThreshold: v })}
        />
      </Section>

      <Section
        title="History"
        actions={<Button size="sm" variant="ghost" onClick={() => void rpc.call("clearHistory").then(() => setHistory([]), (e) => toast.error(errorText(e)))}>Clear</Button>}
      >
        {history.length === 0 ? (
          <p className="text-sm opacity-70">No transcriptions yet.</p>
        ) : history.map((h) => (
          <Row key={h.id} label={new Date(h.at).toLocaleTimeString()} hint={`${h.durationMs} ms`}>
            <div className="flex items-center gap-2">
              <span className="text-sm">{h.text}</span>
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(h.text).then(() => toast("Copied"))}>Copy</Button>
            </div>
          </Row>
        ))}
      </Section>
    </div>
    </div>
  );
}
