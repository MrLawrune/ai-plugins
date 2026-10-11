// bb-plugin-parakeet-stt -- frontend composition root: composer dictation (continuous + one-shot),
// shortcuts, settings page. The pieces live in ./ui.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { controller } from "./dictation.ts";
import { liveRange, liveState } from "./draft-tail.ts";
import { ParakeetPage } from "./page/parakeet-page.tsx";
import { ServerSettings } from "./page/server-settings.tsx";
import { mountCaret, mountCompactDraft, mountNativeMic, mountShortcuts } from "./ui/content-scripts.ts";
import { FloatingMic } from "./ui/floating-mic.tsx";
import { MicAction } from "./ui/mic-action.tsx";
import { RecordingBanner } from "./ui/recording-banner.tsx";
import { runDictation } from "./ui/target.ts";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "dictation",
    actions: [{ id: "mic", component: MicAction }],
    plusMenu: [{
      id: "dictate",
      label: "Dictate",
      icon: "Mic",
      description: "Speak instead of typing",
      disabled: () => controller.snapshot().phase !== "idle",
      run: ({ composer }) => runDictation(composer, "start"),
    }],
    banners: [{ id: "recording", component: RecordingBanner, chrome: "bare" }],
    richText: {
      effects: [{
        id: "live-tail",
        className: "opacity-50",
        match: (text) => {
          const r = liveRange(text, liveState.get());
          return r ? [r] : [];
        },
      }],
    },
  });

  app.composer.experimental_registerCommand({
    id: "toggle-dictation",
    title: "Toggle dictation",
    run: ({ composer }) => runDictation(composer, "toggle"),
  });

  app.contentScripts.register({ id: "caret", mount: ({ signal }) => mountCaret(signal) });
  app.contentScripts.register({ id: "shortcuts", mount: ({ signal }) => mountShortcuts(signal) });
  app.contentScripts.register({ id: "compact-draft", mount: ({ signal }) => mountCompactDraft(signal) });
  app.contentScripts.register({ id: "native-mic", mount: ({ signal }) => mountNativeMic(signal) });

  app.slots.experimental_appOverlay({ id: "floating-mic", component: FloatingMic });

  app.slots.navPanel({ id: "parakeet-stt", title: "Parakeet STT", icon: "Mic", path: "parakeet", component: ParakeetPage });

  app.slots.settingsSection({
    id: "server",
    title: "Server",
    description: "Where the Parakeet server is and how bb signs in to it.",
    component: ServerSettings,
  });
});
