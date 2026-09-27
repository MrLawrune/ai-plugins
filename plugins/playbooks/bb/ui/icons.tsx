// Plugin icons, registered as app icons so host slots (nav panel, tabs, commands) can use them by name.
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import PlayListIcon from "@hugeicons/core-free-icons/PlayListIcon";
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";

export const ICONS = { playbooks: "playbooks-list" } as const;

const ART: Record<(typeof ICONS)[keyof typeof ICONS], IconSvgElement> = { "playbooks-list": PlayListIcon };

export function registerIcons(app: PluginAppBuilder): void {
  for (const [name, icon] of Object.entries(ART)) {
    app.experimental_icons.register({ name, component: ({ className }) => <HugeiconsIcon icon={icon} className={className} strokeWidth={1.75} /> });
  }
}

