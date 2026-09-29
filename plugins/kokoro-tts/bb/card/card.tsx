// The chat card bb renders for a reply's ::kokoro-tts directive: what was said, whether it played, and replay.
import { useEffect, useState, type ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  CancelCircleIcon,
  SpeechIcon,
  StopCircleIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
} from "@hugeicons/core-free-icons";
import { useRealtime, useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../schemas.ts";
import { errorText } from "../util.ts";
import { cardState, findEntry, needsPolling, normalizeSpoken, statusText, type CardState } from "./match.ts";
import { refreshSpeechLog, useSpeechLog } from "./speech-log.ts";

const SOUND_LABEL: Record<string, string> = {
  "sound:working": "Working sound",
  "sound:done": "Done sound",
  "sound:attention": "Attention sound",
};
/** How long Replay keeps the card polling for the new entry before giving up. */
const REPLAY_WAIT_MS = 10_000;

const ICON: Record<CardState["kind"], IconSvgElement> = {
  queued: SpeechIcon,
  playing: VolumeHighIcon,
  spoken: SpeechIcon,
  interrupted: StopCircleIcon,
  muted: VolumeMute01Icon,
  error: CancelCircleIcon,
  unspoken: SpeechIcon,
  unknown: SpeechIcon,
};

const TONE: Record<CardState["kind"], string> = {
  queued: "text-muted-foreground opacity-60",
  playing: "text-primary animate-pulse",
  spoken: "text-primary",
  interrupted: "text-amber-500",
  muted: "text-muted-foreground",
  error: "text-destructive",
  unspoken: "text-muted-foreground opacity-60",
  unknown: "text-muted-foreground opacity-60",
};

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
      <HugeiconsIcon icon={VolumeHighIcon} className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function KokoroCard({ attributes, message }: PluginMessageDirectiveProps) {
  const weight = attributes.weight ?? "";
  const say = attributes.say?.trim() ?? "";
  if (weight === "silent") return null;
  if (Object.hasOwn(SOUND_LABEL, weight)) return <Chip>{SOUND_LABEL[weight]}</Chip>;
  if (weight !== "speech") return <Chip>{`kokoro-tts: unknown weight "${weight}"`}</Chip>;
  if (!say) return <Chip>kokoro-tts: speech with nothing to say</Chip>;
  return <SpeechCard say={say} threadId={message.threadId} />;
}

function SpeechCard({ say, threadId }: { say: string; threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  /** When this card's thread last sent a turn to the server since the card mounted. */
  const [turnAt, setTurnAt] = useState<number | null>(null);
  useRealtime("kokoro-turn", (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) setTurnAt(Date.now());
  });
  /** Entry id at the moment Replay was pressed; the card polls until a newer entry shows up. */
  const [replayAfter, setReplayAfter] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const entries = useSpeechLog(pending);
  const entry = entries ? findEntry(entries, threadId, say) : undefined;
  const state = cardState(entry, { turnAt, now: Date.now() });
  const polling = needsPolling(state) || replayAfter !== null;
  useEffect(() => setPending(polling), [polling]);
  useEffect(() => {
    if (replayAfter !== null && entry && entry.id > replayAfter) setReplayAfter(null);
  }, [entry, replayAfter]);
  useEffect(() => {
    if (replayAfter === null) return;
    const t = setTimeout(() => setReplayAfter(null), REPLAY_WAIT_MS);
    return () => clearTimeout(t);
  }, [replayAfter]);

  const replay = async () => {
    setNote(null);
    try {
      const r = await rpc.call("replay", { threadId, text: normalizeSpoken(say) });
      if (r.status === "no_window") setNote("No bb window can play right now. Click in a bb window to enable audio.");
      else if (r.status === "unsupported") setNote("Restart the Kokoro server to use replay.");
      else if (r.status === "empty_after_strip") setNote("Nothing left to speak after removing markup.");
      else {
        setReplayAfter(entry?.id ?? 0);
        refreshSpeechLog();
      }
    } catch (cause) {
      setNote(`Replay failed: ${errorText(cause)}`);
    }
  };
  const stop = async () => {
    try {
      await rpc.call("interruptAll");
    } catch (cause) {
      setNote(`Stop failed: ${errorText(cause)}`);
    }
    refreshSpeechLog();
  };

  return (
    <div className="my-2 flex max-w-full items-start gap-2.5 rounded-lg border border-border bg-muted/30 px-3 py-2" data-state={state.kind}>
      <HugeiconsIcon icon={ICON[state.kind]} className={cn("mt-0.5 size-4 shrink-0", TONE[state.kind])} />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm text-foreground">{say}</p>
        <p className="text-xs text-muted-foreground" role="status">{statusText(state)}</p>
        {note && <p className="text-xs text-destructive">{note}</p>}
      </div>
      {state.kind === "playing" ? (
        <Button variant="ghost" size="sm" onClick={() => void stop()}>
          <Icon name="Square" className="size-3.5" />
          Stop
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => void replay()}>
          <Icon name="RotateCcw" className="size-3.5" />
          Replay
        </Button>
      )}
    </div>
  );
}
