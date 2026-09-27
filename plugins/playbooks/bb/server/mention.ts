// The @playbooks mention provider: search lists what the caller hands it, resolve renders the context block at send
// time and never throws (a throw would block the send), so any failure becomes a short "unavailable" block.
import type { PluginMentionItem, PluginMentionProviderRegistration, PluginMentionSearchContext } from "@get-bb/plugin-sdk";

export interface MentionItemsContext { query: string; threadId: string | null; projectId: string | null }
export interface MentionDeps {
  /** Renders the Add-to-chat context for one item id (a target ref or a run ref). */
  context(itemId: string): Promise<string>;
  /** Candidate rows, unfiltered; ids are target refs (`lab/site.yml#p0/t1`) or run refs (`run_x/web-02/p0/t1`). */
  items(ctx: MentionItemsContext): PluginMentionItem[];
}

export const MENTION_LIMIT = 20;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createMention(d: MentionDeps): PluginMentionProviderRegistration {
  return {
    id: "playbooks",
    label: "Playbooks",
    search({ query, threadId, projectId }: PluginMentionSearchContext): PluginMentionItem[] {
      try {
        const q = query.trim().toLowerCase();
        const all = d.items({ query, threadId, projectId });
        return all.filter((i) => !q || [i.id, i.title, i.subtitle ?? ""].some((s) => s.toLowerCase().includes(q))).slice(0, MENTION_LIMIT);
      } catch {
        return [];
      }
    },
    async resolve(itemId: string): Promise<{ context: string }> {
      try {
        return { context: await d.context(itemId) };
      } catch (e) {
        return { context: `Playbooks context unavailable for ${itemId}: ${message(e)}. Run \`bb playbooks context ${itemId}\` to retry.` };
      }
    },
  };
}
