// A dictation target bound to one bb composer: writes go through composer.replace so @-mention
// pills keep their ranges, and the draft is locked while a live partial is showing.
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { notePluginEdit, takeCaret } from "../caret-tracker.ts";
import { appendDictation, controller, type Target } from "../dictation.ts";
import { dictationPrefs } from "../dictation-prefs.ts";
import { applyLive, beginAt, liveState } from "../draft-tail.ts";
import { applyTextEdit } from "../draft-edit.ts";

const CONFLICT = "The draft changed under dictation; dictation stopped.";
const CLOSED = "The composer closed; dictation stopped.";
const SELECTION_KEPT = "The selection includes a mention, so it was not replaced; dictating at the end.";

export type NotifyKind = "info" | "error";
type Notify = (message: string, kind?: NotifyKind) => void;
const NOT_DICTATING = { anchor: null, tail: "", dropSeq: null } as const;

/** The one place plugin messages become toasts (controller messages and target messages alike). */
export const toastNotify: Notify = (message, kind = "info") => {
  if (kind === "error") toast.error(message);
  else toast(message);
};

/**
 * Send once the composer shows the plugin's last edit: a voice "send" arrives right after the final
 * that precedes it, before bb has re-rendered the draft. Refusals are shown instead of swallowed.
 */
async function submitWhenSettled(composer: () => PluginComposerApi, notify: Notify, lastDraft: () => string | null): Promise<void> {
  try {
    for (let i = 0; i < 20 && lastDraft() !== null && composer().text !== lastDraft(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!composer().text.trim()) {
      notify("Nothing to send");
      return;
    }
    if (composer().isSubmittingBlocked) {
      notify(`Could not send: ${composer().submittingBlockedReason ?? "blocked"}`, "error");
      return;
    }
    await composer().submit({ experimental_data: {} });
  } catch (e) {
    notify(`Could not send: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** A dictation target for the composer keyed `key`; the live state is shared (one session at a time). */
export function makeTarget(key: string, composer: () => PluginComposerApi, notify: Notify): Target {
  /** Draft as left by this target's last edit; if unchanged at the next start, continue where it ended. */
  let lastPluginDraft: string | null = null;
  /** An edit hit an @-mention in this session: the draft is not what dictation wrote. */
  let failed = false;
  /** The composer unmounted under us; every later write would throw. */
  let closed = false;
  const lock = (on: boolean): void => {
    try {
      composer().setInputLock(on);
    } catch {
      // the composer may already be gone; bb releases the lock when it unmounts
    }
  };
  /** Writes through `replace`; false when the composer is gone (the session is then ended with a notice). */
  const write = (updater: Parameters<PluginComposerApi["replace"]>[0], deferCancel = false): boolean => {
    if (closed) return false;
    try {
      composer().replace(updater);
      return true;
    } catch {
      closed = true;
      liveState.set(NOT_DICTATING);
      notify(CLOSED);
      // begin() runs before the controller enters its session, so cancel once that has happened
      if (deferCancel) queueMicrotask(() => controller.cancel());
      else controller.cancel();
      return false;
    }
  };
  const edit = (fn: (text: string) => string): void => {
    let conflict = false;
    const at = liveState.get().anchor;
    const done = write((cur) => {
      const next = fn(cur.text);
      const r = applyTextEdit(cur, next, at ?? cur.text.length);
      if (r === null) {
        conflict = true;
        liveState.set(NOT_DICTATING);
        return cur;
      }
      if (r !== cur) {
        notePluginEdit();
        lastPluginDraft = next;
      }
      return r;
    });
    if (done && conflict) {
      failed = true;
      notify(CONFLICT, "error");
      controller.cancel();
    }
  };
  return {
    id: key,
    begin: () => {
      failed = false;
      let kept = false;
      write((cur) => {
        const prev = liveState.get();
        const caret = takeCaret(cur.text);
        if (caret) {
          const b = beginAt(cur.text, caret);
          const r = applyTextEdit(cur, b.draft, b.state.anchor ?? undefined);
          if (r !== null) {
            liveState.set(b.state);
            if (r !== cur) {
              notePluginEdit();
              lastPluginDraft = b.draft;
            }
            return r;
          }
          // the selection includes a pill, which is never removed: dictate at the end instead
          kept = true;
          liveState.set(NOT_DICTATING);
          return cur;
        }
        const resume = prev.anchor !== null && cur.text === lastPluginDraft && prev.anchor <= cur.text.length;
        liveState.set({ anchor: resume ? prev.anchor : null, tail: "", dropSeq: null });
        return cur;
      }, true);
      if (kept) notify(SELECTION_KEPT);
    },
    appendText: (text) => edit((d) => {
      const r = applyLive(d, liveState.get(), -1, text, true);
      liveState.set(r.state);
      return r.state.anchor === null ? appendDictation(d, text, dictationPrefs().trailingSpace) : r.draft;
    }),
    submit: () => {
      if (!failed && !closed) void submitWhenSettled(composer, notify, () => lastPluginDraft);
    },
    clear: () => {
      // an explicit whole-draft command: pills go with the text, so no overlap check applies
      liveState.set(NOT_DICTATING);
      write((cur) => {
        if (cur.text === "" && cur.mentions.length === 0) return cur;
        notePluginEdit();
        lastPluginDraft = "";
        return { text: "", mentions: [] };
      });
      lock(false);
    },
    setLive: (text, seq) => {
      edit((d) => {
        const r = applyLive(d, liveState.get(), seq, text, false);
        liveState.set(r.state);
        return r.draft;
      });
      lock(liveState.get().tail !== "");
    },
    commitLive: (text, seq) => {
      edit((d) => {
        const r = applyLive(d, liveState.get(), seq, text, true);
        liveState.set(r.state);
        return r.draft;
      });
      lock(false);
    },
    end: () => lock(false),
  };
}

/**
 * Plus-menu and palette entry: run `verb` on `composer`. A composer with a mounted surface already
 * has a target; otherwise a temporary one lives until the controller is idle again.
 */
export function runDictation(composer: PluginComposerApi, verb: "start" | "toggle"): void {
  const key = composer.key;
  const act = () => (verb === "start" ? controller.start(key) : controller.toggle(key));
  if (controller.has(key)) {
    void act();
    return;
  }
  const unregister = controller.register(makeTarget(key, () => composer, toastNotify));
  let released = false;
  const settle = () => {
    if (released || controller.snapshot().phase !== "idle") return;
    released = true;
    unsubscribe();
    unregister();
  };
  const unsubscribe = controller.subscribe(settle);
  void act().finally(settle);
}
