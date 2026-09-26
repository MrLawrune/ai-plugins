import type { KokoroConfig } from "../schemas.ts";
import { ChoiceGroup, Row, Section, SliderRow, SwitchRow } from "./ui.tsx";

type Patch = (p: Partial<KokoroConfig>, debounceMs?: number) => void;

export const MODES: { value: KokoroConfig["mode"]; label: string; hint: string }[] = [
  { value: "quiet", label: "Quiet", hint: "No speech and no sounds." },
  { value: "ambient", label: "Ambient", hint: "Sounds only: a cue when a reply finishes or needs you." },
  { value: "brief", label: "Brief", hint: "One short spoken sentence per reply." },
  { value: "conversational", label: "Conversational", hint: "Two to four spoken sentences per reply." },
  { value: "verbose", label: "Verbose", hint: "A fuller spoken summary." },
  { value: "full", label: "Full", hint: "Reads the whole reply aloud and skips code." },
];

export function ListeningSection({ config, patch }: { config: KokoroConfig; patch: Patch }) {
  return (
    <Section title="Listening" description="How much you hear when an agent finishes.">
      <Row label="Mode">
        <ChoiceGroup label="Mode" value={config.mode} options={MODES} onChange={(mode) => patch({ mode })} />
      </Row>
      <SliderRow id="speed" label="Speed" value={config.speed} min={0.5} max={2} step={0.05}
        format={(v) => `${v.toFixed(2)}×`} onChange={(v) => patch({ speed: v }, 350)} />
      <SliderRow id="speech_gain" label="Speech volume" value={config.speech_gain} min={0} max={2} step={0.05}
        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch({ speech_gain: v }, 350)} />
      <SwitchRow id="strip_markdown" label="Skip code, links and paths" hint="Leave them out of what is spoken."
        checked={config.strip_markdown} onChange={(v) => patch({ strip_markdown: v })} />
      <SwitchRow id="trim" label="Trim silence" hint="Tighter phrasing between sentences."
        checked={config.trim} onChange={(v) => patch({ trim: v })} />
    </Section>
  );
}
