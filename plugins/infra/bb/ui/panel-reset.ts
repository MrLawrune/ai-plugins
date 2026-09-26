// Re-opening an Infra tab that is already open should show its target again, even if the
// user drilled elsewhere inside it. BB keeps the tab's params unchanged, so openers announce it.
const EVENT = "bb-infra:panel-reset";

export interface PanelReset { target: string | null }

export function requestPanelReset(target: string | null): void {
  window.dispatchEvent(new CustomEvent<PanelReset>(EVENT, { detail: { target } }));
}

export function onPanelReset(cb: (r: PanelReset) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<PanelReset>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
