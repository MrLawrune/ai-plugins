// @infra mentions: attach a live card for an environment, host, or guest when the message is sent.
import type { PluginMentionItem, PluginMentionProviderRegistration } from "@get-bb/plugin-sdk";
import type { InfraService } from "./service.ts";

const MAX_ITEMS = 20;

export function createMention(s: InfraService) {
  return {
    id: "infra",
    label: "Infra",
    search({ query }) {
      const q = query.trim().toLowerCase();
      const items: PluginMentionItem[] = [];
      const add = (id: string, title: string, subtitle: string) => {
        if (items.length < MAX_ITEMS && (!q || id.toLowerCase().includes(q) || title.toLowerCase().includes(q))) items.push({ id, title, subtitle });
      };
      for (const e of s.overview().envs) {
        const view = s.envView(e.env.slug);
        if (!view) continue;
        add(e.env.slug, e.env.name, `environment · ${e.env.kind} · ${e.health}`);
        for (const h of view.hosts) add(`${e.env.slug}/${h.node}`, h.node, `host · ${h.online ? "online" : "offline"} · ${e.env.name}`);
        for (const g of view.guests) add(`${e.env.slug}/${g.node}/${g.vmid}`, g.name, `${g.type} ${g.vmid} · ${g.state} · ${e.env.name}`);
      }
      return items;
    },
    async resolve(itemId) {
      const card = await s.card(itemId, { budget: 40, rules: true });
      if (card === null) throw new Error(`unknown target ${itemId}`);
      return { context: card };
    },
  } satisfies PluginMentionProviderRegistration;
}
