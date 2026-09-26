// bb-plugin-kokoro-tts — frontend entry: the "Kokoro TTS" sidebar panel and the chat chip content script.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountChips } from "./chips/script.ts";
import { mountPlayer } from "./player/script.ts";
import { KokoroPanel } from "./page/panel.tsx";
import { KokoroHeader } from "./page/header.tsx";
import { ServerSettings } from "./page/server-settings.tsx";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "player",
    mount: ({ pluginId, signal }) => mountPlayer({ pluginId, signal }),
  });

  app.contentScripts.register({
    id: "tts-block-summary",
    mount: ({ pluginId, signal }) => mountChips({ pluginId, signal }),
  });

  app.slots.navPanel({
    id: "kokoro-tts",
    title: "Kokoro TTS",
    icon: "Mic",
    path: "kokoro",
    component: KokoroPanel,
    headerContent: KokoroHeader,
  });

  app.slots.settingsSection({
    id: "server",
    title: "Server and engine",
    description: "How the Kokoro server runs and where synthesis happens.",
    component: ServerSettings,
  });
});
