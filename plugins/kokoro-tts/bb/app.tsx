// bb-plugin-kokoro-tts — frontend entry: the "Kokoro TTS" sidebar panel, server settings, and the chat card.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { KokoroCard } from "./card/card.tsx";
import { mountPlayer } from "./player/script.ts";
import { KokoroPanel } from "./page/panel.tsx";
import { KokoroHeader } from "./page/header.tsx";
import { ServerSettings } from "./page/server-settings.tsx";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "player",
    mount: ({ pluginId, signal }) => mountPlayer({ pluginId, signal }),
  });

  // A reply's last line ::kokoro-tts{weight="speech" say="..."} becomes this card.
  app.slots.messageDirective({ id: "kokoro-tts", component: KokoroCard });

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
