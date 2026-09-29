// Voices BB threads: turn end -> /turn, a sent message -> stop, prompts ->
// attention, plus the voice contract as agent instructions.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ConfigCache } from "./config-cache.ts";
import type { PlayerHub } from "./hub.ts";
import type { KokoroClient } from "./kokoro-client.ts";
import type { PrefsStore } from "./prefs.ts";
import { turnResultSchema, type TurnResult } from "./schemas.ts";

export interface VoiceDeps {
  client: () => KokoroClient;
  hub: Pick<PlayerHub, "speak" | "sound" | "stop" | "hasReadyClient">;
  prefs: Pick<PrefsStore, "get">;
  config: Pick<ConfigCache, "get" | "current">;
  /**
   * bb.realtime.publish. "kokoro-turn" tells chat cards a thread's turn is on
   * its way to the server ({ threadId, pending: true }) and then what became of
   * it ({ threadId, action, text?, say?, muted? }: text is the speech-log text
   * it made, say the reply's directive say, muted whether mute silenced it).
   */
  publish: (channel: string, payload: unknown) => void;
  /** The reply ends with a ::kokoro-tts directive that bb renders as a card. */
  contract: string | null;
  /** Short contract for full mode, which reads the whole reply and ignores directives. */
  contractFull?: string | null;
}

export function registerVoice(bb: BbPluginApi, deps: VoiceDeps): void {
  /** Server playback always works; client playback needs a window to play in. */
  const canVoice = () => deps.prefs.get().playback === "server" || deps.hub.hasReadyClient();
  const warn = (name: string, cause: unknown) =>
    bb.log.warn(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
  /**
   * The /turn in flight per thread. A thread going active (or away) while its
   * /turn is out cancels it, so the reply is dropped instead of talking over
   * the next turn.
   */
  const inflight = new Map<string, { cancelled: boolean }>();
  const cancelTurn = (threadId: string) => {
    const turn = inflight.get(threadId);
    if (turn) turn.cancelled = true;
  };

  // Full mode reads the whole reply and ignores directives, so it gets a short
  // contract that tells the agent not to write them.
  bb.agents.contributeInstructions(() => {
    const mode = deps.config.get()?.config.mode ?? "brief";
    const contract = mode === "full" && deps.contractFull ? deps.contractFull : deps.contract;
    return contract ? contract.replaceAll("{{MODE}}", mode) : null;
  });

  const deliver = (r: TurnResult, sessionId: string) => {
    if (r.action === "speech" && r.text && r.entry_id !== undefined) {
      deps.hub.speak(r.entry_id, r.text, sessionId, r.speech_gain ?? 1);
    } else if (r.action === "sound" && r.sound) {
      deps.hub.sound(r.sound, r.sound_volume ?? 1, sessionId);
    }
  };

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (thread.parentThreadId || !canVoice()) return;
    const text = lastAssistantText?.trim();
    if (!text) return;
    const threadId = thread.id;
    const { playback } = deps.prefs.get();
    const turn = { cancelled: false };
    inflight.set(threadId, turn);
    let outcome: { threadId: string; action: string; text?: string; say?: string; muted?: boolean } =
      { threadId, action: "silent" };
    try {
      deps.publish("kokoro-turn", { threadId, pending: true });
      const parsed = turnResultSchema.safeParse(
        await deps.client().call<unknown>("POST", "/turn", { text, session_id: threadId, playback }),
      );
      if (!parsed.success) return;
      const r = parsed.data;
      outcome = {
        threadId, action: r.action,
        ...(r.logged_text ? { text: r.logged_text } : {}),
        ...(r.say_text ? { say: r.say_text } : {}),
        ...(r.muted ? { muted: true } : {}),
      };
      if (turn.cancelled) {
        // The thread moved on while /turn was out: drop the reply. When a newer
        // turn owns the thread, the server already replaced this playback with
        // that one's, and interrupting now would cut the newer reply off.
        if (playback === "client") {
          if (r.entry_id !== undefined) {
            await deps.client().call("POST", "/speech-log/status", { id: r.entry_id, status: "interrupted" });
          }
        } else if (inflight.get(threadId) === turn) {
          await deps.client().call("POST", "/interrupt", { session_id: threadId });
        }
        return;
      }
      if (playback === "client") deliver(r, threadId);
    } catch (cause) {
      warn("thread.idle", cause);
    } finally {
      if (inflight.get(threadId) === turn) inflight.delete(threadId);
      deps.publish("kokoro-turn", outcome);
    }
  });

  bb.events.on("thread.active", async ({ thread }) => {
    if (thread.parentThreadId) return;
    cancelTurn(thread.id);
    try {
      if (deps.prefs.get().playback === "client") deps.hub.stop(thread.id);
      else await deps.client().call("POST", "/interrupt", { session_id: thread.id });
    } catch (cause) {
      warn("thread.active", cause);
    }
  });

  bb.events.on("interaction.pending", async ({ thread }) => {
    try {
      if (thread.parentThreadId || !canVoice()) return;
      const { playback } = deps.prefs.get();
      if (playback === "server") {
        await deps.client().call("POST", "/cue", { sound: "attention", session_id: thread.id, playback });
        return;
      }
      // The window plays the ping, so decide here what /cue would.
      const { config, muted } = await deps.config.current();
      if (muted || config.mode === "quiet" || !config.attention_sound) return;
      deps.hub.sound("attention", config.sound_volume, thread.id);
    } catch (cause) {
      warn("interaction.pending", cause);
    }
  });

  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      if (thread.parentThreadId) return;
      cancelTurn(thread.id);
      try {
        deps.hub.stop(thread.id);
        await deps.client().call("POST", "/cleanup", { session_id: thread.id });
      } catch (cause) {
        warn(event, cause);
      }
    });
  }
}
