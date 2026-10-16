// The per-profile and shared dictation settings: how it starts, how it listens, voice commands, vocabulary.
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { SHORTCUTS, type Prefs } from "../schemas.ts";
import type { PrefsPatch } from "./panel-state.ts";
import { ChoiceGroup, Row, Section, SliderRow, SwitchRow } from "./ui.tsx";

/** Sliders save once they stop moving. */
export const SLIDER_DEBOUNCE_MS = 600;

export const SHARED = "Shared: a change applies to all profiles.";

interface SectionProps {
  prefs: Prefs;
  patch: PrefsPatch;
  profileName: string;
}

const SHORTCUT_LABELS: Record<Prefs["shortcut"], string> = {
  "ctrl+space": "Ctrl+Space",
  "alt+space": "Alt+Space",
  "ctrl+shift+space": "Ctrl+Shift+Space",
  off: "Off",
};

const SHORTCUT_HINT = "Works while bb has focus. Esc cancels a recording. “Toggle dictation” is also in bb's command palette (Mod+Shift+P) and toggles the session from any composer, which stops a session running in another composer.";

const MODES: { value: Prefs["mode"]; label: string; hint: string }[] = [
  { value: "continuous", label: "Continuous", hint: "Commits text at each pause and keeps listening." },
  { value: "oneshot", label: "One-shot", hint: "Records until you stop, then transcribes once." },
];

const asText = (v: string | string[]) => (Array.isArray(v) ? v.join(", ") : v);
const items = (text: string) => [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];

/** A text field that saves on blur or Enter; `parse` turns the text into the saved value. */
function TextRow<V extends string | string[]>({ id, label, hint, value, parse, onSave }: {
  id: string;
  label: string;
  hint?: string;
  value: V;
  /** Returns null when the text cannot be saved, which puts the saved value back. */
  parse: (text: string) => V | null;
  onSave: (v: V) => void;
}) {
  const shown = asText(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const next = parse(text);
    if (next === null) {
      setText(shown);
      return;
    }
    setText(asText(next));
    if (JSON.stringify(next) !== JSON.stringify(value)) onSave(next);
  };
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <Input id={id} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
    </Row>
  );
}

const phrase = (text: string) => text.trim() || null;

export function DictationSection({ prefs, patch, profileName }: SectionProps) {
  return (
    <Section
      title="Dictation"
      description={`Saved to the ${profileName} profile. Tap the mic for the mode below; press and hold it for one-shot push-to-talk.`}
    >
      <Row label="Mode">
        <ChoiceGroup label="Mode" value={prefs.mode} options={MODES} onChange={(mode) => patch({ mode })} />
      </Row>
      <Row label="Shortcut" hint={SHORTCUT_HINT}>
        <ChoiceGroup
          label="Shortcut"
          value={prefs.shortcut}
          options={SHORTCUTS.map((s) => ({ value: s, label: SHORTCUT_LABELS[s] }))}
          onChange={(shortcut) => patch({ shortcut })}
        />
      </Row>
      <SwitchRow id="hold" label="Hold to talk" hint="Record only while the shortcut is held." checked={prefs.holdToTalk} onChange={(holdToTalk) => patch({ holdToTalk })} />
      <SwitchRow id="submit" label="Auto-submit" hint="Send the message after a one-shot dictation." checked={prefs.autoSubmit} onChange={(autoSubmit) => patch({ autoSubmit })} />
      <SwitchRow id="space" label="Trailing space" checked={prefs.trailingSpace} onChange={(trailingSpace) => patch({ trailingSpace })} />
      <SwitchRow id="sounds" label="Sound cues" checked={prefs.soundCues} onChange={(soundCues) => patch({ soundCues })} />
      <SwitchRow id="native" label="Hide bb's voice button" hint="Keep one mic in the composer." checked={prefs.hideNativeMic} onChange={(hideNativeMic) => patch({ hideNativeMic })} />
    </Section>
  );
}

export function ContinuousSection({ prefs, patch, profileName }: SectionProps) {
  return (
    <Section title="Continuous dictation" description={`Saved to the ${profileName} profile.`}>
      <SwitchRow id="preview" label="Live preview" hint="Show the phrase in progress, dimmed." checked={prefs.livePreview} onChange={(livePreview) => patch({ livePreview })} />
      <SliderRow id="pause" label="Pause before commit" hint="How long a pause ends a phrase." value={prefs.pauseMs} min={300} max={1500} step={50}
        format={(v) => `${v} ms`} onChange={(pauseMs) => patch({ pauseMs }, SLIDER_DEBOUNCE_MS)} />
      <SwitchRow id="silence" label="End on silence" hint="Stop listening after a stretch of silence." checked={prefs.endOnSilence} onChange={(endOnSilence) => patch({ endOnSilence })} />
      {prefs.endOnSilence ? (
        <SliderRow id="silence-s" label="Silence timeout" value={prefs.silenceTimeoutS} min={3} max={60} step={1}
          format={(v) => `${v} s`} onChange={(silenceTimeoutS) => patch({ silenceTimeoutS }, SLIDER_DEBOUNCE_MS)} />
      ) : null}
      <SwitchRow id="hidden" label="Keep listening when the screen is off" hint="Off: locking the phone ends dictation." checked={prefs.keepListeningHidden} onChange={(keepListeningHidden) => patch({ keepListeningHidden })} />
      <SwitchRow id="floating" label="Floating mic on phones" hint="Dictate without opening the keyboard." checked={prefs.floatingMic} onChange={(floatingMic) => patch({ floatingMic })} />
      <SwitchRow id="compact" label="Show more lines in the collapsed composer" hint="Phones: wrap the draft instead of cutting it off." checked={prefs.expandCompactDraft} onChange={(expandCompactDraft) => patch({ expandCompactDraft })} />
    </Section>
  );
}

export function CommandsSection({ prefs, patch, profileName }: SectionProps) {
  const phrases = (key: "sendPhrase" | "stopPhrase" | "clearPhrase", id: string, label: string, hint: string) => (
    <TextRow id={id} label={label} hint={`${hint} ${SHARED}`} value={prefs[key]} parse={phrase} onSave={(v) => patch({ [key]: v })} />
  );
  return (
    <Section
      title="Voice commands"
      description={`Saying a phrase does something instead of typing it. On or off is saved to the ${profileName} profile; the phrases are shared. Separate alternatives with commas (for example: send it, sunday).`}
    >
      <SwitchRow id="commands" label="Voice commands" hint="Send and stop count at the end of a sentence; clear and start phrases count anywhere."
        checked={prefs.voiceCommands} onChange={(voiceCommands) => patch({ voiceCommands })} />
      {prefs.voiceCommands ? (
        <>
          {phrases("sendPhrase", "send-phrase", "Send phrase", "Sends the message.")}
          {phrases("stopPhrase", "stop-phrase", "Stop phrase", "Ends dictation.")}
          {phrases("clearPhrase", "clear-phrase", "Clear phrase", "Empties the message box and keeps listening.")}
          <SwitchRow id="wait-start" label="Wait for a start phrase" hint="The mic ignores speech until you say a start phrase; the send phrase sends and goes back to waiting."
            checked={prefs.waitForStart} onChange={(waitForStart) => patch({ waitForStart })} />
          {prefs.waitForStart ? (
            <TextRow id="start-phrases" label="Start phrases" hint={`Anything said after one is kept. The banner shows what it heard while waiting. ${SHARED}`}
              value={prefs.startPhrases} parse={items} onSave={(startPhrases) => patch({ startPhrases })} />
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

export function VocabularySection({ prefs, patch }: Omit<SectionProps, "profileName">) {
  return (
    <Section title="Vocabulary" description="Shared by all profiles and devices.">
      <TextRow id="words" label="Custom words" hint={`Comma-separated; fixes spelling and case (for example: tmux, CLAUDE.md). ${SHARED}`}
        value={prefs.customWords} parse={items} onSave={(customWords) => patch({ customWords })} />
      <SwitchRow id="fillers" label="Remove filler words" hint={`um, uh, er… ${SHARED}`} checked={prefs.removeFillers} onChange={(removeFillers) => patch({ removeFillers })} />
      <SliderRow id="threshold" label="Correction strength" hint={`Higher corrects more aggressively. ${SHARED}`} value={prefs.correctionThreshold}
        min={0} max={0.5} step={0.01} format={(v) => v.toFixed(2)} onChange={(correctionThreshold) => patch({ correctionThreshold }, SLIDER_DEBOUNCE_MS)} />
    </Section>
  );
}
