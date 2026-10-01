// Voices BB threads: resolves each thread's voice and hands its events to the
// turn coordinator, plus the voice contract as agent instructions.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TurnCoordinator } from "./coord/turns.ts";
import type { PlayerHub } from "./hub.ts";
import type { Settings } from "./schemas.ts";
import { resolveVoice, type ResolvedVoice, type VoiceScopes } from "./scopes.ts";

export interface VoiceDeps {
  turns: TurnCoordinator;
  hub: Pick<PlayerHub, "hasReadyClient">;
  settings: () => Settings;
  /** Per-thread and per-project voice settings, and the parent links they inherit through. */
  scopes: Pick<VoiceScopes, "get" | "learnParent" | "forget">;
  /** bb.realtime.publish; "kokoro-turn" { threadId, action: "off" } tells chat cards the thread's voice is off. */
  publish: (channel: string, payload: unknown) => void;
  /** The reply ends with a ::kokoro-tts directive that bb renders as a card. */
  contract: string | null;
  /** Short contract for full mode, which reads the whole reply and ignores directives. */
  contractFull?: string | null;
}

export function registerVoice(bb: BbPluginApi, deps: VoiceDeps): void {
  const warn = (name: string, cause: unknown) =>
    bb.log.warn(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
  const globalMode = () => deps.settings().mode;
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
  /** A child that is not voiced and never spoke here needs no stop or cleanup. */
  const ignorable = (thread: EventThread, v: ResolvedVoice) =>
    thread.parentThreadId !== null && !v.voiced && !deps.turns.hasSpoken(thread.id);

  // Full mode reads the whole reply and ignores directives, so it gets a short
  // contract that tells the agent not to write them. An off thread gets none.
  bb.agents.contributeInstructions(({ threadId, projectId }) => {
    const v = resolveVoice(deps.scopes.get(), globalMode(), threadId, projectId);
    if (!v.voiced) return null;
    const contract = v.mode === "full" && deps.contractFull ? deps.contractFull : deps.contract;
    return contract ? contract.replaceAll("{{MODE}}", v.mode) : null;
  });

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (!lastAssistantText?.trim()) return;
    const v = voiceOf(thread);
    if (!v.voiced) {
      deps.publish("kokoro-turn", { threadId: thread.id, action: "off" });
      return;
    }
    if (!deps.hub.hasReadyClient()) return;
    await deps.turns.idle(thread.id, lastAssistantText, v.mode);
  });

  // A failed turn never fires idle, so it stops the same way a new one does.
  for (const event of ["thread.active", "thread.failed"] as const) {
    bb.events.on(event, async ({ thread }) => {
      if (ignorable(thread, voiceOf(thread))) return;
      await deps.turns.interrupt(thread.id);
    });
  }

  bb.events.on("interaction.pending", async ({ thread }) => {
    const v = voiceOf(thread);
    if (v.voiced) await deps.turns.attention(thread.id, v.mode);
  });

  bb.events.on("thread.archived", async ({ thread }) => {
    if (ignorable(thread, voiceOf(thread))) return;
    await deps.turns.archived(thread.id);
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    try {
      await deps.scopes.forget(thread.id);
    } catch (cause) {
      warn("scopes", cause);
    }
    // Always: a deleted thread's log rows go even when nothing here remembers it speaking.
    await deps.turns.deleted(thread.id);
  });

  bb.events.on("thread.created", ({ thread }) => {
    voiceOf(thread);
  });
}
