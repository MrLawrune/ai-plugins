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

  const refresh = useCallback(async () => {
    const [p, h, hist] = await Promise.all([rpc.call("getPrefs"), rpc.call("health"), rpc.call("listHistory")]);
    setPrefs(p);
    setDictationPrefs(p);
    setHealth(h);
    setHistory(hist.entries);
    setWords(p.customWords.join(", "));
  }, [rpc]);
  useEffect(() => { void refresh().catch((e) => toast.error(errorText(e))); }, [refresh]);

  const patch = async (p: Partial<Prefs>) => {
    try {
      const next = await rpc.call("setPrefs", p);
      setPrefs(next);
      setDictationPrefs(next);
      setWords(next.customWords.join(", "));
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  if (!prefs) return null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
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
        <SwitchRow id="submit" label="Auto-submit" hint="Send the message after dictating" checked={prefs.autoSubmit} onChange={(v) => void patch({ autoSubmit: v })} />
        <SwitchRow id="space" label="Trailing space" checked={prefs.trailingSpace} onChange={(v) => void patch({ trailingSpace: v })} />
        <SwitchRow id="sounds" label="Sound cues" checked={prefs.soundCues} onChange={(v) => void patch({ soundCues: v })} />
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
  );
}
