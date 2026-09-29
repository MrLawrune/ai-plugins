// Once at startup: drop voice settings and parent links for threads bb no longer has.
import type { VoiceScopes } from "./scopes.ts";

/** bb.sdk throws a BbHttpError { status, code } for a missing or deleted thread. */
export function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null
    && (cause as { status?: unknown }).status === 404
    && (cause as { code?: unknown }).code === "thread_not_found";
}

export async function pruneScopes(
  scopes: Pick<VoiceScopes, "get" | "forget">,
  exists: (threadId: string) => Promise<boolean | null>,
  signal: AbortSignal,
): Promise<void> {
  const { threads, parents } = scopes.get();
  for (const id of new Set([...Object.keys(threads), ...Object.keys(parents)])) {
    if (signal.aborted) return;
    try {
      if ((await exists(id)) === false) await scopes.forget(id);
    } catch {
      // keep going; the next start tries again
    }
  }
}
