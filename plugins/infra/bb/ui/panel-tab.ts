// Infra thread-panel tabs are independent: BB keys a tab by (action, params), so each target
// opened from the chip or a chat card gets its own tab, and "+" opens the param-less home tab.

type PluginTab = { kind: string; pluginId?: string; actionId?: string; paramsJson?: string | null };

const canonical = (v: unknown) => JSON.stringify(v ?? null);

/** The persisted tab list without the one tab identified by this panel's own params. */
export function withoutOwnTab<T extends PluginTab>(tabs: T[], pluginId: string, actionId: string, params: unknown): T[] {
  const own = canonical(params);
  return tabs.filter((t) => {
    if (t.kind !== "plugin-panel" || t.pluginId !== pluginId || t.actionId !== actionId) return true;
    let p: unknown = null;
    try { p = t.paramsJson ? JSON.parse(t.paramsJson) : null; } catch { return true; }
    return canonical(p) !== own;
  });
}
