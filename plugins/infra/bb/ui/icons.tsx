// Plugin icons, registered as app icons so host slots (nav panel, tabs, commands) can use them by name.
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import Activity01Icon from "@hugeicons/core-free-icons/Activity01Icon";
import ContainerIcon from "@hugeicons/core-free-icons/ContainerIcon";
import ComputerIcon from "@hugeicons/core-free-icons/ComputerIcon";
import ServerStack02Icon from "@hugeicons/core-free-icons/ServerStack02Icon";
import ServerIcon from "@hugeicons/core-free-icons/ServerIcon";
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";

export const ICONS = {
  infra: "infra-stack",
  host: "infra-host",
  lxc: "infra-lxc",
  qemu: "infra-vm",
  activity: "infra-activity",
} as const;

const ART: Record<(typeof ICONS)[keyof typeof ICONS], IconSvgElement> = {
  "infra-stack": ServerStack02Icon,
  "infra-host": ServerIcon,
  "infra-lxc": ContainerIcon,
  "infra-vm": ComputerIcon,
  "infra-activity": Activity01Icon,
};

export function registerIcons(app: PluginAppBuilder): void {
  for (const [name, icon] of Object.entries(ART)) {
    app.experimental_icons.register({ name, component: ({ className }) => <HugeiconsIcon icon={icon} className={className} strokeWidth={1.75} /> });
  }
}

/** Direct render for plugin-owned UI; the vendored Icon component does not resolve plugin app icons. */
export function InfraIcon({ name, className }: { name: keyof typeof ICONS; className?: string }) {
  return <HugeiconsIcon icon={ART[ICONS[name]]} className={className} strokeWidth={1.75} aria-hidden />;
}
