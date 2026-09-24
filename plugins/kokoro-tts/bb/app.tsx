// bb-plugin-kokoro-tts — frontend entry: the "Kokoro TTS" sidebar page.
import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type {
  ConfigResponse,
  DeviceInfo,
  Health,
  KokoroConfig,
  VoiceInfo,
  rpcContract,
} from "./schemas.ts";
import { mountPlayer } from "./player/script.ts";
import { EngineCard } from "./page/engine-card.tsx";
import { PlaybackCard } from "./page/playback-card.tsx";
import { ServerCard } from "./page/server-card.tsx";
import { errorText, Row, Section, SliderRow, SwitchRow, useDebouncedPatch } from "./page/ui.tsx";
import { usePrefs, useSetupStatus } from "./page/use-prefs.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import type { IconSvgElement } from "@hugeicons/react";
import {
  CancelCircleIcon,
  SpeechIcon,
  StopCircleIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
} from "@hugeicons/core-free-icons";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Patch = Partial<KokoroConfig>;

const MODES: { value: KokoroConfig["mode"]; label: string; hint: string }[] = [
  { value: "quiet", label: "Quiet", hint: "Silence" },
  { value: "ambient", label: "Ambient", hint: "Sounds only" },
  { value: "brief", label: "Brief", hint: "1 sentence" },
  { value: "conversational", label: "Conversational", hint: "2-4 sentences" },
  { value: "verbose", label: "Verbose", hint: "Full detail" },
];

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

// ---------------------------------------------------------------------------
// Data hook: config + health, patch with optimistic local state.
// ---------------------------------------------------------------------------

function useKokoro() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [health, setHealth] = useState<{ up: boolean; health?: Health; error?: string } | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshHealth = useCallback(async () => {
    const result = await rpc.call("health");
    setHealth(result.up ? { up: true, health: result.health } : { up: false, error: result.error });
    return result.up;
  }, [rpc]);

  const loadAll = useCallback(async () => {
    try {
      const [cfg, v, d] = await Promise.all([
        rpc.call("getConfig"),
        rpc.call("listVoices"),
        rpc.call("listDevices"),
      ]);
      setData(cfg);
      setVoices(v.voices);
      setDevices(d.devices);
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  }, [rpc]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const up = await refreshHealth().catch(() => false);
      if (cancelled) return;
      if (up && data === null) await loadAll();
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // data is intentionally read once per tick via closure; loadAll guards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshHealth, loadAll, data === null]);

  const patch = useCallback(
    async (p: Patch) => {
      // Optimistic update; revert on failure.
      const previous = data;
      if (previous) setData({ ...previous, config: { ...previous.config, ...p } });
      try {
        const next = await rpc.call("patchConfig", p);
        setData(next);
      } catch (cause) {
        if (previous) setData(previous);
        toast.error(`Kokoro: ${errorText(cause)}`);
      }
    },
    [rpc, data],
  );

  const setMuted = useCallback(
    async (muted: boolean) => {
      try {
        const r = await rpc.call("setMuted", { muted });
        setData((d) => (d ? { ...d, muted: r.muted } : d));
        void refreshHealth();
      } catch (cause) {
        toast.error(`Kokoro: ${errorText(cause)}`);
      }
    },
    [rpc, refreshHealth],
  );

  return { rpc, data, health, voices, devices, loadError, patch, setMuted, reload: loadAll };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

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
                <span className="font-mono text-xs">{v.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{v.gender}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function VoiceSection({ config, voices, patch, rpc }: {
  config: KokoroConfig;
  voices: VoiceInfo[];
  patch: (p: Patch) => Promise<void>;
  rpc: Rpc;
}) {
  const isBlend = typeof config.voice !== "string";
  const blend: Record<string, number> = isBlend ? (config.voice as Record<string, number>) : {};
  const single = typeof config.voice === "string" ? config.voice : "";
  const [addName, setAddName] = useState("");
  const [previewText, setPreviewText] = useState("");
  const debounced = useDebouncedPatch(patch);

  const total = Object.values(blend).reduce((a, b) => a + b, 0) || 1;
  const voiceByName = useMemo(() => new Map(voices.map((v) => [v.name, v])), [voices]);
  const available = voices.filter((v) => !(v.name in blend));

  const preview = (voice: KokoroConfig["voice"]) =>
    rpc
      .call("preview", {
        voice,
        speed: config.speed,
        lang: config.lang,
        speech_gain: config.speech_gain,
        ...(previewText.trim() ? { text: previewText.trim() } : {}),
      })
      .then(
        (r) => {
          if (r.status !== "playing") toast.message(`Preview: ${r.status}`);
        },
        (e) => toast.error(errorText(e)),
      );

  const setBlend = (next: Record<string, number>, immediate = true) => {
    const names = Object.keys(next);
    if (names.length === 0) return;
    const value: KokoroConfig["voice"] = names.length === 1 ? names[0] : next;
    if (immediate) void patch({ voice: value });
    else debounced({ voice: value });
  };

  return (
    <Section
      title="Voice"
      description={isBlend ? "Weighted blend of several voices." : "A single named voice."}
      actions={
        <Button variant="outline" size="sm" onClick={() => void preview(config.voice)}>
          <Icon name="Play" className="size-3.5" />
          Preview
        </Button>
      }
    >
      {!isBlend ? (
        <Row label="Voice" htmlFor="voice">
          <div className="flex gap-2">
            <VoiceSelect id="voice" value={single} voices={voices} onChange={(name) => void patch({ voice: name })} />
            <Button
              variant="ghost"
              size="sm"
              aria-label="Convert to a blend"
              onClick={() => {
                const other = available.find((v) => v.name !== single && v.lang === voiceByName.get(single)?.lang);
                if (!other) return;
                void patch({ voice: { [single]: 1, [other.name]: 1 } });
              }}
            >
              <Icon name="Plus" className="size-3.5" />
              Blend
            </Button>
          </div>
        </Row>
      ) : (
        <div className="space-y-3">
          {Object.entries(blend).map(([name, weight]) => {
            const info = voiceByName.get(name);
            return (
              <div key={name} className="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs">{name}</div>
                  <div className="text-xs text-muted-foreground">
                    {info ? `${info.language} · ${info.gender}` : ""} · {Math.round((weight / total) * 100)}%
                  </div>
                </div>
                <Slider
                  min={0}
                  max={5}
                  step={0.1}
                  value={[weight]}
                  onValueChange={([v]) => setBlend({ ...blend, [name]: v }, false)}
                  onValueCommit={([v]) => setBlend({ ...blend, [name]: v })}
                  aria-label={`Weight for ${name}`}
                />
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="size-7" aria-label="Preview this voice alone" onClick={() => void preview(name)}>
                    <Icon name="Play" className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    aria-label="Remove from blend"
                    disabled={Object.keys(blend).length <= 1}
                    onClick={() => {
                      const next = { ...blend };
                      delete next[name];
                      setBlend(next);
                    }}
                  >
                    <Icon name="Trash2" className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
          <div className="flex gap-2">
            <div className="flex-1">
              <VoiceSelect value={addName} voices={available} onChange={setAddName} placeholder="Add a voice to the blend" />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!addName}
              onClick={() => {
                setBlend({ ...blend, [addName]: 1 });
                setAddName("");
              }}
            >
              <Icon name="Plus" className="size-3.5" />
              Add
            </Button>
          </div>
        </div>
      )}
      <Row label="Preview text" hint="Optional. Leave empty for the default sample." htmlFor="preview-text">
        <Input
          id="preview-text"
          value={previewText}
          onChange={(e) => setPreviewText(e.target.value)}
          placeholder="This is how I will sound when reading your updates."
        />
      </Row>
    </Section>
  );
}

function SpeechSection({ config, patch }: { config: KokoroConfig; patch: (p: Patch) => Promise<void> }) {
  const debounced = useDebouncedPatch(patch);
  return (
    <Section title="Speech" description="Applies to the next spoken response.">
      <Row label="Mode" hint="Verbosity ceiling the hooks enforce.">
        <div role="radiogroup" className="flex flex-wrap gap-1.5">
          {MODES.map((m) => (
            <Button
              key={m.value}
              role="radio"
              aria-checked={config.mode === m.value}
              variant={config.mode === m.value ? "default" : "outline"}
              size="sm"
              aria-label={m.hint}
              onClick={() => void patch({ mode: m.value })}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </Row>
      <SliderRow
        id="speed"
        label="Speed"
        hint="0.5x to 2.0x"
        value={config.speed}
        min={0.5}
        max={2}
        step={0.05}
        format={(v) => `${v.toFixed(2)}x`}
        onChange={(v) => debounced({ speed: v })}
      />
      <SliderRow
        id="speech_gain"
        label="Speech volume"
        value={config.speech_gain}
        min={0}
        max={2}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => debounced({ speech_gain: v })}
      />
      <Row label="Language" hint="Phonemizer language. Match the voice's language." htmlFor="lang">
        <Select value={config.lang} onValueChange={(v) => void patch({ lang: v })}>
          <SelectTrigger id="lang" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGS.map((l) => (
              <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <SwitchRow id="strip_markdown" label="Strip markdown" hint="Remove code, links, and paths before speaking." checked={config.strip_markdown} onChange={(v) => void patch({ strip_markdown: v })} />
      <SwitchRow id="trim" label="Trim silence" hint="Cut silence between chunks for tighter phrasing." checked={config.trim} onChange={(v) => void patch({ trim: v })} />
    </Section>
  );
}

function SoundsSection({ config, patch, rpc }: { config: KokoroConfig; patch: (p: Patch) => Promise<void>; rpc: Rpc }) {
  const debounced = useDebouncedPatch(patch);
  const play = (sound: "working" | "done" | "attention" | "error") =>
    rpc.call("playSound", { sound }).then(
      (r) => {
        if (r.status !== "playing") toast.message(`Sound: ${r.status}`);
      },
      (e) => toast.error(errorText(e)),
    );
  return (
    <Section
      title="Sounds"
      description="Short cues for working, done, and attention states."
      actions={
        <div className="flex gap-1">
          {(["working", "done", "attention", "error"] as const).map((s) => (
            <Button key={s} variant="ghost" size="sm" onClick={() => void play(s)} aria-label={`Play ${s} sound`}>
              <Icon name="Play" className="size-3.5" />
              {s}
            </Button>
          ))}
        </div>
      }
    >
      <SliderRow
        id="sound_volume"
        label="Sound volume"
        value={config.sound_volume}
        min={0}
        max={2}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => debounced({ sound_volume: v })}
      />
      <SwitchRow id="working_sound" label="Working tick" hint="Play a soft tick after each intermediate step." checked={config.working_sound} onChange={(v) => void patch({ working_sound: v })} />
      <SwitchRow id="attention_sound" label="Attention ping" hint="Ping on permission prompts and idle waits." checked={config.attention_sound} onChange={(v) => void patch({ attention_sound: v })} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function KokoroPage() {
  const { rpc, data, health, voices, devices, loadError, patch, setMuted } = useKokoro();
  const { prefs, setPrefs } = usePrefs();
  const setupState = useSetupStatus();
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <ServerCard
          health={health}
          data={data}
          setMuted={setMuted}
          rpc={rpc}
          setupState={setupState}
          prefs={prefs}
          setPrefs={setPrefs}
        />
        {loadError ? (
          <p role="alert" className="text-sm text-destructive">{loadError}</p>
        ) : null}
        {data ? (
          <>
            <EngineCard
              data={data}
              patch={patch}
              rpc={rpc}
              prefs={prefs}
              setPrefs={setPrefs}
              setupState={setupState}
              up={health?.up === true}
            />
            {prefs ? (
              <PlaybackCard
                prefs={prefs}
                setPrefs={setPrefs}
                config={data.config}
                outputDevices={devices}
                patch={patch}
                setupState={setupState}
              />
            ) : null}
            <VoiceSection config={data.config} voices={voices} patch={patch} rpc={rpc} />
            <SpeechSection config={data.config} patch={patch} />
            <SoundsSection config={data.config} patch={patch} rpc={rpc} />
          </>
        ) : health?.up ? (
          <p className="text-sm text-muted-foreground">Loading configuration…</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Changes save immediately and apply on the next spoken turn. In Claude Code outside bb, per-session
          env vars (<code className="font-mono">KOKORO_MODE</code>, <code className="font-mono">KOKORO_VOICE</code>,
          <code className="ml-1 font-mono">KOKORO_SPEED</code>) still override them.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat: render the voice contract's HTML-comment block as a compact summary
// ---------------------------------------------------------------------------

const TTS_BLOCK = /<!--\s*TTS_RESPONSE\s+weight="([^"]+)"\s*(?:\n([\s\S]*?)\nTTS_RESPONSE\s*)?-->/g;
const TTS_MARK = "data-kokoro-tts";
const CHIP_CLASS = "kokoro-tts-chip";
/** How long a speech chip waits for the hook to report before showing "not spoken". */
const PENDING_GRACE_MS = 25_000;
/** Chips rendered this soon after mount are history, not live turns. */
const HISTORY_WINDOW_MS = 4_000;
let mountedAt = 0;

type ChipState = "pending" | "unknown" | "spoken" | "playing" | "interrupted" | "unspoken" | "error" | "muted" | "sound" | "silent";

const CHIP_ICON: Record<ChipState, IconSvgElement> = {
  pending: SpeechIcon,
  unknown: SpeechIcon,
  spoken: SpeechIcon,
  playing: SpeechIcon,
  interrupted: StopCircleIcon,
  unspoken: CancelCircleIcon,
  error: CancelCircleIcon,
  muted: VolumeMute01Icon,
  sound: VolumeHighIcon,
  silent: VolumeMute01Icon,
};

const CHIP_TITLE: Record<ChipState, string> = {
  pending: "Waiting for the voice hook",
  unknown: "No playback record (older than the speech log)",
  spoken: "Spoken",
  playing: "Speaking now",
  interrupted: "Speech was interrupted",
  unspoken: "Not spoken (no record from the voice hook)",
  error: "Speech failed",
  muted: "Muted when this was sent",
  sound: "Sound cue",
  silent: "Silent turn",
};

/** Render a hugeicons definition to an inline SVG string (no React in the content script). */
function iconSvg(def: IconSvgElement): string {
  const body = def
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${String(v)}"`)
        .join(" ");
      return `<${tag} ${a}/>`;
    })
    .join("");
  return `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true">${body}</svg>`;
}

const ICON_SVG = Object.fromEntries(
  Object.entries(CHIP_ICON).map(([k, v]) => [k, iconSvg(v)]),
) as Record<ChipState, string>;

function normText(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

function setChipState(chip: HTMLElement, state: ChipState, detail?: string) {
  if (chip.dataset.kokoroState === state && chip.dataset.kokoroDetail === (detail ?? "")) return;
  chip.dataset.kokoroState = state;
  chip.dataset.kokoroDetail = detail ?? "";
  const icon = chip.querySelector(".kokoro-tts-icon");
  if (icon) icon.innerHTML = ICON_SVG[state];
  chip.title = detail ? `${CHIP_TITLE[state]} — ${detail}` : CHIP_TITLE[state];
}

function initialState(weight: string): ChipState {
  if (weight === "speech") return "pending";
  if (weight === "silent") return "silent";
  return "sound";
}

function makeChip(weight: string, label: string): HTMLElement {
  const chip = document.createElement("span");
  chip.setAttribute(TTS_MARK, weight);
  chip.setAttribute("data-kokoro-label", label);
  chip.dataset.kokoroSeen = String(Date.now());
  // Chips that appear while the page is still rendering history were not
  // spoken in this session; a missing log entry means "unknown", not "failed".
  if (Date.now() - mountedAt < HISTORY_WINDOW_MS) chip.dataset.kokoroHistoric = "1";
  chip.className = CHIP_CLASS;
  const icon = document.createElement("span");
  icon.className = "kokoro-tts-icon";
  chip.appendChild(icon);
  chip.appendChild(document.createTextNode(label));
  setChipState(chip, initialState(weight));
  return chip;
}

/** Replace raw TTS_RESPONSE comment text with chips. Returns true if any speech chip was added. */
function summarizeTtsBlocks(root: ParentNode): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Text).data.includes("TTS_RESPONSE")) hits.push(n as Text);
  }
  let addedSpeech = false;
  for (const node of hits) {
    const el = node.parentElement;
    if (!el || el.closest(`[${TTS_MARK}]`) || el.closest("pre, code, textarea, input")) continue;
    const text = node.data;
    const blocks: { weight: string; label: string }[] = [];
    const stripped = text.replace(TTS_BLOCK, (_m, weight: string, spoken?: string) => {
      const said = (spoken ?? "").trim();
      const label = said || (weight === "silent" ? "silent" : weight.replace("sound:", "sound: "));
      blocks.push({ weight, label });
      return "";
    });
    if (blocks.length === 0) continue;
    // Mutate the text node in place instead of replacing it: React keeps a
    // reference to this node and re-renders would otherwise re-insert the raw
    // block next to a chip we already added (duplicate chips).
    if (stripped !== text) node.data = stripped;
    const existing = Array.from(el.querySelectorAll<HTMLElement>(`:scope > span[${TTS_MARK}]`));
    let anchor: Node = node;
    for (const b of blocks) {
      const dup = existing.find(
        (e) => e.getAttribute(TTS_MARK) === b.weight && e.getAttribute("data-kokoro-label") === b.label,
      );
      if (dup) {
        anchor = dup;
        continue;
      }
      const chip = makeChip(b.weight, b.label);
      (anchor as ChildNode).after(chip);
      existing.push(chip);
      anchor = chip;
      if (b.weight === "speech") addedSpeech = true;
    }
  }
  return addedSpeech;
}

type LogEntry = { text: string; status: string; error?: string; first_audio_ms?: number; ts: number };

function stateFromEntry(e: LogEntry): [ChipState, string | undefined] {
  switch (e.status) {
    case "done":
      return ["spoken", e.first_audio_ms != null ? `${e.first_audio_ms} ms to first audio` : undefined];
    case "queued":
    case "playing":
      return ["playing", undefined];
    case "interrupted":
      return ["interrupted", undefined];
    case "error":
      return ["error", e.error];
    case "muted":
      return ["muted", undefined];
    case "empty":
      return ["error", "nothing left to speak after stripping markup"];
    default:
      return ["pending", undefined];
  }
}

/**
 * Apply speech-log entries to speech chips. Matching is by normalized spoken
 * text (what the hook sends is the block content). Returns true while any chip
 * still needs a later refresh (pending inside the grace window, or playing).
 */
function applySpeechLog(entries: LogEntry[]): boolean {
  const byText = new Map<string, LogEntry>();
  for (const e of entries) byText.set(e.text, e); // later entries win
  const now = Date.now();
  let needsRefresh = false;
  for (const chip of Array.from(document.querySelectorAll<HTMLElement>(`span.${CHIP_CLASS}[${TTS_MARK}="speech"]`))) {
    const label = chip.getAttribute("data-kokoro-label") ?? "";
    const hit = byText.get(normText(label));
    if (hit) {
      const [state, detail] = stateFromEntry(hit);
      setChipState(chip, state, detail);
      if (state === "playing") needsRefresh = true;
      continue;
    }
    const seen = Number(chip.dataset.kokoroSeen ?? now);
    if (now - seen < PENDING_GRACE_MS) {
      setChipState(chip, "pending");
      needsRefresh = true;
    } else {
      setChipState(chip, chip.dataset.kokoroHistoric ? "unknown" : "unspoken");
    }
  }
  return needsRefresh;
}

async function fetchSpeechLog(pluginId: string, signal: AbortSignal): Promise<LogEntry[] | null> {
  try {
    const res = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/speechLog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok: boolean; result?: { entries: LogEntry[] } };
    return data.ok && data.result ? data.result.entries : null;
  } catch {
    return null;
  }
}

const CHIP_CSS = `
.${CHIP_CLASS}{display:inline-flex;gap:.4em;align-items:baseline;font-size:.8em;color:var(--muted-foreground,#888);border:1px solid var(--border,#3333);border-radius:.4em;padding:.05em .5em;margin-top:.25em;line-height:1.4}
.${CHIP_CLASS} .kokoro-tts-icon{display:inline-flex;align-self:center;font-size:1.15em;line-height:1}
.${CHIP_CLASS} .kokoro-tts-icon svg{display:block}
.${CHIP_CLASS}[data-kokoro-state="spoken"] .kokoro-tts-icon{color:var(--primary,#8ab4f8)}
.${CHIP_CLASS}[data-kokoro-state="playing"] .kokoro-tts-icon{color:var(--primary,#8ab4f8);animation:kokoro-pulse 1.2s ease-in-out infinite}
.${CHIP_CLASS}[data-kokoro-state="pending"] .kokoro-tts-icon,
.${CHIP_CLASS}[data-kokoro-state="unknown"] .kokoro-tts-icon{opacity:.45}
.${CHIP_CLASS}[data-kokoro-state="unspoken"] .kokoro-tts-icon,
.${CHIP_CLASS}[data-kokoro-state="error"] .kokoro-tts-icon{color:var(--destructive,#e5484d)}
.${CHIP_CLASS}[data-kokoro-state="interrupted"] .kokoro-tts-icon{color:var(--warning,#e0a526)}
@keyframes kokoro-pulse{0%,100%{opacity:1}50%{opacity:.35}}
`;

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "player",
    mount: ({ pluginId, signal }) => mountPlayer({ pluginId, signal }),
  });

  app.contentScripts.register({
    id: "tts-block-summary",
    mount({ signal, pluginId }) {
      mountedAt = Date.now();
      const style = document.createElement("style");
      style.textContent = CHIP_CSS;
      document.head.appendChild(style);

      let scheduled = false;
      let refreshTimer: ReturnType<typeof setTimeout> | null = null;
      let refreshing = false;
      let lastFetch = 0;

      const scheduleRefresh = (delay: number) => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refresh(), delay);
      };
      const refresh = async () => {
        if (signal.aborted || refreshing) return;
        if (!document.querySelector(`span.${CHIP_CLASS}[${TTS_MARK}="speech"]`)) return;
        refreshing = true;
        lastFetch = Date.now();
        const entries = await fetchSpeechLog(pluginId, signal);
        refreshing = false;
        if (signal.aborted) return;
        const again = entries ? applySpeechLog(entries) : true;
        if (again) scheduleRefresh(entries ? 2500 : 8000);
      };

      const run = () => {
        scheduled = false;
        const added = summarizeTtsBlocks(document.body);
        if (added) scheduleRefresh(Math.max(0, 1500 - (Date.now() - lastFetch)));
      };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(run);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      schedule();
      const onVisible = () => {
        if (document.visibilityState === "visible") scheduleRefresh(0);
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        observer.disconnect();
        if (refreshTimer) clearTimeout(refreshTimer);
        document.removeEventListener("visibilitychange", onVisible);
        style.remove();
        document.querySelectorAll(`.${CHIP_CLASS}`).forEach((c) => c.remove());
      };
    },
  });

  app.slots.navPanel({
    id: "kokoro-tts",
    title: "Kokoro TTS",
    icon: "Mic",
    path: "kokoro",
    component: KokoroPage,
  });
});
