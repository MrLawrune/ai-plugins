// Voices BB threads: turn end -> /turn, typing -> stop, prompts -> attention,
// plus the voice contract as agent instructions and a server heartbeat.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PlayerHub } from "./hub.ts";
import type { KokoroClient } from "./kokoro-client.ts";
import type { PrefsStore } from "./prefs.ts";
import { turnResultSchema, type ConfigResponse } from "./schemas.ts";
import { sleep } from "./util.ts";

export interface VoiceDeps {
  client: () => KokoroClient;
  hub: Pick<PlayerHub, "speak" | "sound" | "stop" | "hasReadyClient">;
  prefs: Pick<PrefsStore, "get">;
  /** bb.realtime.publish; tells chat cards a thread's turn is on its way to the server. */
  publish: (channel: string, payload: unknown) => void;
  /** The reply ends with a ::kokoro-tts directive that bb renders as a card. */
  contract: string | null;
  /** Short contract for full mode, which reads the whole reply and ignores directives. */
  contractFull?: string | null;
}

export function registerVoice(bb: BbPluginApi, deps: VoiceDeps): void {
  let mode = "brief";
  /** Server playback always works; client playback needs a window to play in. */
  const canVoice = () => deps.prefs.get().playback === "server" || deps.hub.hasReadyClient();
  const warn = (name: string, cause: unknown) =>
    bb.log.warn(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);

  // Keeps the verbosity mode in the agent instructions current.
  bb.background.service("voice-heartbeat", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          mode = (await deps.client().call<ConfigResponse>("GET", "/config")).config.mode;
        } catch {
          // Server down or (re)starting: keep the last known mode and retry soon.
          await sleep(1_000, signal);
          continue;
        }
        await sleep(10_000, signal);
      }
    },
  });

  // Full mode reads the whole reply and ignores directives, so it gets a short
  // contract that tells the agent not to write them.
  bb.agents.contributeInstructions(() => {
    const contract = mode === "full" && deps.contractFull ? deps.contractFull : deps.contract;
    return contract ? contract.replaceAll("{{MODE}}", mode) : null;
  });

  const deliver = (raw: unknown, sessionId: string) => {
    const parsed = turnResultSchema.safeParse(raw);
    if (!parsed.success) return;
    const r = parsed.data;
    if (r.action === "speech" && r.text && r.entry_id !== undefined) {
      deps.hub.speak(r.entry_id, r.text, sessionId, r.speech_gain ?? 1);
    } else if (r.action === "sound" && r.sound) {
      deps.hub.sound(r.sound, r.sound_volume ?? 1, sessionId);
    }
  };

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    try {
      if (thread.parentThreadId || !canVoice()) return;
      const text = lastAssistantText?.trim();
      if (!text) return;
      const { playback } = deps.prefs.get();
      deps.publish("kokoro-turn", { threadId: thread.id });
      const reply = await deps.client().call<unknown>("POST", "/turn", {
        text, session_id: thread.id, playback,
      });
      if (playback === "client") deliver(reply, thread.id);
    } catch (cause) {
      warn("thread.idle", cause);
    }
  });

  bb.events.on("thread.active", async ({ thread }) => {
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
      const reply = await deps.client().call<unknown>("POST", "/cue", {
        sound: "attention", session_id: thread.id, playback,
      });
      if (playback === "client") deliver(reply, thread.id);
    } catch (cause) {
      warn("interaction.pending", cause);
    }
  });

  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      try {
        deps.hub.stop(thread.id);
        await deps.client().call("POST", "/cleanup", { session_id: thread.id });
      } catch (cause) {
        warn(event, cause);
      }
    });
  }
}
