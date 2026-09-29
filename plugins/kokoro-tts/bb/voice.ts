// Voices BB threads: turn end -> /turn, a sent message -> stop, prompts ->
// attention, plus the voice contract as agent instructions.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ConfigCache } from "./config-cache.ts";
import type { PlayerHub } from "./hub.ts";
import type { KokoroClient } from "./kokoro-client.ts";
import type { PrefsStore } from "./prefs.ts";
import { turnResultSchema, type Mode, type TurnResult } from "./schemas.ts";
import { resolveVoice, type ResolvedVoice, type VoiceScopes } from "./scopes.ts";

export interface VoiceDeps {
  client: () => KokoroClient;
  hub: Pick<PlayerHub, "speak" | "sound" | "stop" | "hasReadyClient">;
  prefs: Pick<PrefsStore, "get">;
  config: Pick<ConfigCache, "get" | "current">;
  /** Per-thread and per-project voice settings, and the parent links they inherit through. */
  scopes: Pick<VoiceScopes, "get" | "learnParent" | "forget">;
  /**
   * bb.realtime.publish. "kokoro-turn" tells chat cards a thread's turn is on
   * its way to the server ({ threadId, pending: true }) and then what became of
   * it ({ threadId, action, text?, say?, muted? }: text is the speech-log text
   * it made, say the reply's directive say, muted whether mute silenced it), or
   * that the thread's voice is off ({ threadId, action: "off" }).
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
  /** The server's mode, or null while its config is not known. */
  const globalMode = (): Mode | null => deps.config.get()?.config.mode ?? null;
  /** Threads this process has voiced; a child among them is still stopped after it is switched off. */
  const spoke = new Set<string>();
  type EventThread = { id: string; parentThreadId: string | null; projectId: string };
  /**
   * The thread's voice, from what the event says about its parent (so a failed
   * or pending write never makes a child a root).
   */
  const resolveOnly = (thread: EventThread): ResolvedVoice => {
    const data = deps.scopes.get();
    const known = thread.parentThreadId && data.parents[thread.id] !== thread.parentThreadId
      ? { ...data, parents: { ...data.parents, [thread.id]: thread.parentThreadId } }
      : data;
    return resolveVoice(known, globalMode(), thread.id, thread.projectId);
  };
  /**
   * resolveOnly, and the parent is stored in the background for the
   * instruction path, which only has the thread id.
   */
  const voiceOf = (thread: EventThread): ResolvedVoice => {
    void deps.scopes.learnParent(thread.id, thread.parentThreadId).catch((cause: unknown) => warn("scopes", cause));
    return resolveOnly(thread);
  };
  /** A mode for the request body only when an override chose it; else the server applies its own. */
  const modeField = (v: ResolvedVoice) => (v.modeFrom === "global" ? {} : { mode: v.mode });
  /** A child that is not voiced, has nothing in flight, and never spoke here needs no stop or cleanup. */
  const ignorable = (thread: EventThread, v: ResolvedVoice) =>
    thread.parentThreadId !== null && !v.voiced && !inflight.has(thread.id) && !spoke.has(thread.id);

  // Full mode reads the whole reply and ignores directives, so it gets a short
  // contract that tells the agent not to write them. An off thread gets none.
  bb.agents.contributeInstructions(({ threadId, projectId }) => {
    const v = resolveVoice(deps.scopes.get(), globalMode(), threadId, projectId);
    if (!v.voiced) return null;
    const contract = v.mode === "full" && deps.contractFull ? deps.contractFull : deps.contract;
    return contract ? contract.replaceAll("{{MODE}}", v.mode) : null;
  });

  const deliver = (r: TurnResult, sessionId: string) => {
    if (r.action === "speech" && r.text && r.entry_id !== undefined) {
      deps.hub.speak(r.entry_id, r.text, sessionId, r.speech_gain ?? 1);
    } else if (r.action === "sound" && r.sound) {
      deps.hub.sound(r.sound, r.sound_volume ?? 1, sessionId);
    }
  };

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const text = lastAssistantText?.trim();
    if (!text) return;
    const threadId = thread.id;
    const v = voiceOf(thread);
    if (!v.voiced) {
      deps.publish("kokoro-turn", { threadId, action: "off" });
      return;
    }
    if (!canVoice()) return;
    const { playback } = deps.prefs.get();
    const turn = { cancelled: false };
    inflight.set(threadId, turn);
    let outcome: { threadId: string; action: string; text?: string; say?: string; muted?: boolean } =
      { threadId, action: "silent" };
    try {
      deps.publish("kokoro-turn", { threadId, pending: true });
      spoke.add(threadId);
      const parsed = turnResultSchema.safeParse(
        await deps.client().call<unknown>("POST", "/turn", { text, session_id: threadId, playback, ...modeField(v) }),
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
    if (ignorable(thread, voiceOf(thread))) return;
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
      const v = voiceOf(thread);
      if (!v.voiced || !canVoice()) return;
      const { playback } = deps.prefs.get();
      if (playback === "server") {
        spoke.add(thread.id);
        await deps.client().call("POST", "/cue", { sound: "attention", session_id: thread.id, playback, ...modeField(v) });
        return;
      }
      // The window plays the ping, so decide here what /cue would. Being voiced
      // rules out quiet, except a global quiet an empty cache could not show.
      const { config, muted } = await deps.config.current();
      if (v.modeFrom === "global" && config.mode === "quiet") return;
      if (muted || !config.attention_sound) return;
      spoke.add(thread.id);
      deps.hub.sound("attention", config.sound_volume, thread.id);
    } catch (cause) {
      warn("interaction.pending", cause);
    }
  });

  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      let v: ResolvedVoice;
      if (event === "thread.deleted") {
        // Resolved before forgetting, so a child voiced by its own mode still gets its cleanup.
        v = resolveOnly(thread);
        try {
          await deps.scopes.forget(thread.id);
        } catch (cause) {
          warn("scopes", cause);
        }
      } else {
        v = voiceOf(thread);
      }
      if (ignorable(thread, v)) return;
      cancelTurn(thread.id);
      try {
        deps.hub.stop(thread.id);
        await deps.client().call("POST", "/cleanup", { session_id: thread.id });
      } catch (cause) {
        warn(event, cause);
      } finally {
        spoke.delete(thread.id);
      }
    });
  }

  bb.events.on("thread.created", ({ thread }) => {
    voiceOf(thread);
  });
}
