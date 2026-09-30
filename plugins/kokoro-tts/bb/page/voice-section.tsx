import { useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import type { rpcContract } from "../contract.ts";
import type { KokoroConfig, VoiceInfo } from "../schemas.ts";
import { Disclosure, errorText, Row, Section } from "./ui.tsx";

type Patch = (p: Partial<KokoroConfig>, debounceMs?: number) => void;

const LANGS: { value: string; label: string }[] = [
  { value: "en-us", label: "English (US)" },
  { value: "en-gb", label: "English (UK)" },
  { value: "es", label: "Spanish" },
  { value: "fr-fr", label: "French" },
  { value: "hi", label: "Hindi" },
  { value: "it", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "pt-br", label: "Portuguese (BR)" },
  { value: "cmn", label: "Mandarin" },
];

function groupVoices(voices: VoiceInfo[]): { language: string; voices: VoiceInfo[] }[] {
  const map = new Map<string, VoiceInfo[]>();
  for (const v of voices) {
    const list = map.get(v.language) ?? [];
    list.push(v);
    map.set(v.language, list);
  }
  return [...map.entries()].map(([language, vs]) => ({ language, voices: vs }));
}

function VoiceSelect({ value, voices, onChange, id, placeholder }: {
  value: string;
  voices: VoiceInfo[];
  onChange: (name: string) => void;
  id?: string;
  placeholder?: string;
}) {
  const groups = useMemo(() => groupVoices(voices), [voices]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder ?? "Choose a voice"} />
      </SelectTrigger>
      <SelectContent>
        {groups.map((g) => (
          <SelectGroup key={g.language}>
            <SelectLabel>{g.language}</SelectLabel>
            {g.voices.map((v) => (
              <SelectItem key={v.name} value={v.name}>
                {v.name} <span className="text-xs text-muted-foreground">({v.gender})</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Choosing a voice also picks its language, so pronunciation follows the voice. */
export function voicePatch(name: string, voices: VoiceInfo[]): Partial<KokoroConfig> {
  const lang = voices.find((v) => v.name === name)?.lang;
  return lang ? { voice: name, lang } : { voice: name };
}

export function playbackStatusToast(kind: "Preview" | "Sound", status: string): void {
  if (status === "playing") return;
  if (status === "no_window") {
    toast.message("No bb window can play audio yet. Click anywhere in a bb window, then try again.");
    return;
  }
  toast.message(`${kind}: ${status}`);
}

export function VoiceSection({ config, voices, patch }: { config: KokoroConfig; voices: VoiceInfo[]; patch: Patch }) {
  const rpc = useRpc<typeof rpcContract>();
  const isBlend = typeof config.voice !== "string";
  const blend: Record<string, number> = isBlend ? (config.voice as Record<string, number>) : {};
  const single = typeof config.voice === "string" ? config.voice : "";
  const [addName, setAddName] = useState("");
  const [sampleText, setSampleText] = useState("");
  const total = Object.values(blend).reduce((a, b) => a + b, 0) || 1;
  const voiceByName = useMemo(() => new Map(voices.map((v) => [v.name, v])), [voices]);
  const available = voices.filter((v) => !(v.name in blend));
  const blendPartner = available.find((v) => v.name !== single && v.lang === voiceByName.get(single)?.lang)
    ?? available.find((v) => v.name !== single);

  const preview = (voice: KokoroConfig["voice"]) =>
    rpc.call("preview", {
      voice, speed: config.speed, lang: config.lang, speech_gain: config.speech_gain,
      ...(sampleText.trim() ? { text: sampleText.trim() } : {}),
    }).then((r) => playbackStatusToast("Preview", r.status), (e) => toast.error(errorText(e)));

  const setBlend = (next: Record<string, number>, debounceMs = 0) => {
    const names = Object.keys(next);
    if (names.length === 0) return;
    patch({ voice: names.length === 1 ? names[0] : next }, debounceMs);
  };

  return (
    <Section
      title="Voice"
      actions={
        <Button variant="outline" size="sm" onClick={() => void preview(config.voice)}>
          <Icon name="Play" className="size-3.5" />
          Play sample
        </Button>
      }
    >
      {!isBlend ? (
        <Row label="Voice" htmlFor="voice">
          <div className="flex gap-2">
            <VoiceSelect id="voice" value={single} voices={voices} onChange={(name) => patch(voicePatch(name, voices))} />
            <Button variant="ghost" size="sm" disabled={!blendPartner}
              onClick={() => blendPartner && patch({ voice: { [single]: 1, [blendPartner.name]: 1 } })}>
              <Icon name="Plus" className="size-3.5" />
              Blend
            </Button>
          </div>
        </Row>
      ) : (
        <div className="space-y-4">
          {Object.entries(blend).map(([name, weight]) => {
            const info = voiceByName.get(name);
            const pct = `${Math.round((weight / total) * 100)}%`;
            return (
              <div key={name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
                <div className="min-w-0">
                  <div className="truncate text-sm">{name} <span className="text-xs text-muted-foreground">{pct}</span></div>
                  <div className="text-xs text-muted-foreground">{info ? `${info.language} · ${info.gender}` : ""}</div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="size-7" aria-label={`Play ${name} alone`} onClick={() => void preview(name)}>
                    <Icon name="Play" className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${name} from the blend`} disabled={Object.keys(blend).length <= 1}
                    onClick={() => { const next = { ...blend }; delete next[name]; setBlend(next); }}>
                    <Icon name="Trash2" className="size-3.5" />
                  </Button>
                </div>
                <Slider className="col-span-2" min={0.1} max={5} step={0.1} value={[weight]}
                  thumbLabel={`Share of ${name}`} thumbValueText={pct}
                  onValueChange={([v]) => setBlend({ ...blend, [name]: v }, 350)}
                  onValueCommit={([v]) => setBlend({ ...blend, [name]: v })} />
              </div>
            );
          })}
          <div className="flex gap-2">
            <div className="flex-1">
              <VoiceSelect value={addName} voices={available} onChange={setAddName} placeholder="Add a voice to the blend" />
            </div>
            <Button variant="outline" size="sm" disabled={!addName}
              onClick={() => { setBlend({ ...blend, [addName]: 1 }); setAddName(""); }}>
              <Icon name="Plus" className="size-3.5" />
              Add
            </Button>
          </div>
        </div>
      )}
      <Disclosure label="Pronunciation and sample text">
        <Row label="Language" hint="Follows the voice. Change it only to force another pronunciation." htmlFor="lang">
          <Select value={config.lang} onValueChange={(v) => patch({ lang: v })}>
            <SelectTrigger id="lang" className="w-full sm:w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              {LANGS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
        <Row label="Sample text" hint={`${sampleText.length}/400 characters. Empty plays the default sentence.`} htmlFor="sample-text">
          <Input id="sample-text" value={sampleText} maxLength={400} onChange={(e) => setSampleText(e.target.value)}
            placeholder="This is how I will sound when reading your updates." />
        </Row>
      </Disclosure>
    </Section>
  );
}
