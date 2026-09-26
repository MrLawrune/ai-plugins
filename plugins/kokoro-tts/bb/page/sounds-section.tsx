import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { KokoroConfig, rpcContract } from "../schemas.ts";
import { errorText, Section, SliderRow, SwitchRow } from "./ui.tsx";
import { playbackStatusToast } from "./voice-section.tsx";

type Patch = (p: Partial<KokoroConfig>, debounceMs?: number) => void;
const SOUNDS = ["working", "done", "attention", "error"] as const;

export function SoundsSection({ config, patch }: { config: KokoroConfig; patch: Patch }) {
  const rpc = useRpc<typeof rpcContract>();
  const play = (sound: (typeof SOUNDS)[number]) =>
    rpc.call("playSound", { sound }).then((r) => playbackStatusToast("Sound", r.status), (e) => toast.error(errorText(e)));
  return (
    <Section
      title="Sounds"
      description="Short cues instead of, or alongside, speech."
      actions={
        <div className="flex flex-wrap gap-1">
          {SOUNDS.map((s) => (
            <Button key={s} variant="ghost" size="sm" onClick={() => void play(s)} aria-label={`Play the ${s} sound`}>
              <Icon name="Play" className="size-3.5" />
              {s}
            </Button>
          ))}
        </div>
      }
    >
      <SliderRow id="sound_volume" label="Cue volume" value={config.sound_volume} min={0} max={2} step={0.05}
        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch({ sound_volume: v }, 350)} />
      <SwitchRow id="working_sound" label="Working tick" hint="A soft tick while an agent is still working (Claude Code)."
        checked={config.working_sound} onChange={(v) => patch({ working_sound: v })} />
      <SwitchRow id="attention_sound" label="Attention ping" hint="When an agent needs your input."
        checked={config.attention_sound} onChange={(v) => patch({ attention_sound: v })} />
    </Section>
  );
}
