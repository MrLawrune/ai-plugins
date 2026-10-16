// A fake bb composer over an in-memory draft, for the dictation target tests.
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { vi } from "vitest";

export type Mention = { from: number; to: number; label: string; kind: "project"; projectId: string };
export const pill = (from: number, to: number): Mention => ({ from, to, label: "Alex", kind: "project", projectId: "p" });

/** The slice of PluginComposerApi the target uses, over an in-memory draft. */
export function fakeComposer(text: string, mentions: Mention[] = [], key = "k1") {
  const state = { text, mentions, blocked: false, reason: null as string | null, closed: false, layout: "expanded" as "compact" | "expanded" };
  const lock: boolean[] = [];
  const submit = vi.fn(async (_options: unknown) => {});
  const api = {
    key,
    get layout() { return state.layout; },
    get text() { return state.text; },
    get draft() { return { text: state.text, mentions: state.mentions, attachments: [] }; },
    get isSubmittingBlocked() { return state.blocked; },
    get submittingBlockedReason() { return state.reason; },
    replace(next: (cur: unknown) => { text: string; mentions: Mention[] }) {
      if (state.closed) throw new Error("This composer is no longer available.");
      const cur = api.draft;
      const r = next(cur);
      if (r !== cur) { state.text = r.text; state.mentions = r.mentions; }
    },
    setInputLock: (on: boolean) => {
      if (state.closed) throw new Error("This composer is no longer available.");
      lock.push(on);
    },
    submit,
  };
  return { api: api as unknown as PluginComposerApi, state, lock, submit };
}

