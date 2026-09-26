// bb-plugin-infra — frontend entry: every slot registration lives here.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { GuestDirective, HostDirective } from "./ui/directive.tsx";
import { HeaderChip } from "./ui/header-chip.tsx";
import { HomepageStrip } from "./ui/homepage.tsx";
import { ICONS, registerIcons } from "./ui/icons.tsx";
import { InfraOverlay, navigateToInfra } from "./ui/overlay.tsx";
import { ActivityTab, InfraAccessory, InfraHeader, InfraPage, PANEL_PATH } from "./ui/page.tsx";
import { mountRowStatus } from "./ui/row-status.ts";
import { SettingsSection } from "./ui/settings.tsx";
import { PANEL_ACTION_ID, ThreadInfraPanel } from "./ui/thread-panel.tsx";

export default definePluginApp((app) => {
  registerIcons(app);

  app.slots.navPanel({
    id: "infra",
    title: "Infra",
    icon: ICONS.infra,
    path: PANEL_PATH,
    component: InfraPage,
    headerContent: InfraHeader,
    experimental_sidebarAccessory: InfraAccessory,
    fixedTabs: [{ panelId: "infra", id: "activity", title: "Agent activity", icon: ICONS.activity, component: ActivityTab, layout: "flush" }],
  });

  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Infra",
    icon: ICONS.infra,
    layout: "flush",
    component: ThreadInfraPanel,
    run: ({ openPanel }) => { openPanel({ title: "Infra" }); },
  });

  app.slots.messageDirective({ id: "infra-guest", component: GuestDirective });
  app.slots.messageDirective({ id: "infra-host", component: HostDirective });
  app.slots.experimental_threadHeaderAction({ id: "infra", title: "Infra targets", component: HeaderChip });
  app.slots.homepageSection({ id: "infra", title: "Infrastructure", component: HomepageStrip });
  app.slots.experimental_appOverlay({ id: "infra", component: InfraOverlay });
  app.contentScripts.register({ id: "row-status", mount: mountRowStatus });

  app.commands.register({
    id: "open",
    title: "Infra: open environments",
    run: () => { navigateToInfra(); },
  });
  app.commands.register({
    id: "thread-panel",
    title: "Infra: show this thread's infrastructure",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => { openPanel({ actionId: PANEL_ACTION_ID, title: "Infra" }); },
  });

  app.slots.settingsSection({
    id: "environments",
    title: "Environments",
    description: "Proxmox hosts and clusters this plugin reads from. Read-only: nothing here changes your infrastructure.",
    component: SettingsSection,
  });
});
