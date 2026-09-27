// bb-plugin-playbooks — frontend entry: every slot registration lives here.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ICONS, registerIcons } from "./ui/icons.tsx";
import { PlaybookDirective } from "./ui/directive.tsx";
import { HeaderChip } from "./ui/header-chip.tsx";
import { RunDirective } from "./ui/run-directive.tsx";
import { RunInteraction } from "./ui/run-interaction.tsx";
import { SettingsSection } from "./ui/settings.tsx";
import { PANEL_ACTION_ID, ThreadPlaybooksPanel } from "./ui/thread-panel.tsx";

export default definePluginApp((app) => {
  registerIcons(app);

  app.commands.register({
    id: "thread-panel",
    title: "Playbooks: show this thread's playbooks",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => { openPanel({ actionId: "playbooks", title: "Playbooks" }); },
  });

  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Playbooks",
    icon: ICONS.playbooks,
    layout: "flush",
    component: ThreadPlaybooksPanel,
    run: ({ openPanel }) => { openPanel({ title: "Playbooks" }); },
  });

  app.slots.messageDirective({ id: "playbook", component: PlaybookDirective });

  app.slots.messageDirective({ id: "playbook-run", component: RunDirective });

  app.slots.experimental_threadHeaderAction({ id: "playbooks", title: "Playbook runs", component: HeaderChip });

  app.slots.pendingInteraction({ id: "run", component: RunInteraction });

  app.slots.settingsSection({
    id: "environments",
    title: "Environments",
    description: "Control hosts and playbook repositories this plugin runs Ansible against.",
    component: SettingsSection,
  });
});
