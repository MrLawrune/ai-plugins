// Decides when a running capture must stop: optionally when the page is hidden (screen off), and
// always when the browser ends the mic track itself. Returns a release function.
import type { Interruption } from "./dictation.ts";

interface DocLike {
  visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}
interface TrackLike { onended: ((this: never, ev: never) => unknown) | (() => void) | null }

export function guardCapture(o: {
  doc: DocLike;
  tracks: TrackLike[];
  keepListeningHidden: () => boolean;
  onInterrupt: (why: Interruption) => void;
}): () => void {
  const onVisibility = () => {
    if (o.doc.visibilityState === "hidden" && !o.keepListeningHidden()) o.onInterrupt("hidden");
  };
  o.doc.addEventListener("visibilitychange", onVisibility);
  for (const t of o.tracks) t.onended = () => o.onInterrupt("lost");
  return () => {
    o.doc.removeEventListener("visibilitychange", onVisibility);
    for (const t of o.tracks) t.onended = null;
  };
}
