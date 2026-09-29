// Per-thread and per-project voice settings, and how a thread's effective one is worked out.
import type { KvLike } from "./prefs.ts";
import { scopeSettingSchema, type Mode, type ScopeSetting } from "./schemas.ts";

const SETTINGS_KEY = "voice-scopes";
const PARENTS_KEY = "voice-parents";
const MAX_DEPTH = 16;
/** kv values are capped at 256 KB; the parent map only grows, so keep the newest links. */
export const MAX_PARENTS = 2000;

export interface ScopesData {
  threads: Record<string, ScopeSetting>;
  projects: Record<string, ScopeSetting>;
  /** child thread id -> parent thread id; roots are not stored */
  parents: Record<string, string>;
}
export interface ScopePatch { mode?: Mode | null; voiceChildren?: boolean | null }
export interface ResolvedVoice {
  mode: Mode;
  voiced: boolean;
  modeFrom: "thread" | "parent" | "project" | "global";
  isChild: boolean;
  childrenFrom: "parent" | "project" | null;
}
export type ScopesChange = "settings" | "parents";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keeps each entry that parses; drops the rest. */
function settingsOf(raw: unknown): Record<string, ScopeSetting> {
  const out: Record<string, ScopeSetting> = {};
  if (!isRecord(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    const parsed = scopeSettingSchema.safeParse(value);
    if (parsed.success && Object.keys(parsed.data).length) out[id] = parsed.data;
  }
  return out;
}

function parentsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(raw)) return out;
  for (const [id, value] of Object.entries(raw)) if (typeof value === "string" && value) out[id] = value;
  return out;
}

/** Ancestors of threadId, nearest first, at most MAX_DEPTH, stopping on a cycle. */
function ancestors(parents: Record<string, string>, threadId: string): string[] {
  const out: string[] = [];
  const seen = new Set([threadId]);
  let id = parents[threadId];
  while (id !== undefined && !seen.has(id) && out.length < MAX_DEPTH) {
    out.push(id);
    seen.add(id);
    id = parents[id];
  }
  return out;
}

/**
 * The effective voice for a thread. globalMode is null when the server's
 * config is not known yet: the mode then reads "brief" and is not treated as
 * quiet, so the server's own mode decides.
 */
export function resolveVoice(data: ScopesData, globalMode: Mode | null, threadId: string, projectId: string | null): ResolvedVoice {
  const own = data.threads[threadId] ?? {};
  const up = ancestors(data.parents, threadId);
  const project = (projectId && data.projects[projectId]) || {};
  const fromParent = up.map((id) => data.threads[id]?.mode).find((m) => m !== undefined);
  let mode: Mode = globalMode ?? "brief";
  let modeFrom: ResolvedVoice["modeFrom"] = "global";
  if (own.mode !== undefined) [mode, modeFrom] = [own.mode, "thread"];
  else if (fromParent !== undefined) [mode, modeFrom] = [fromParent, "parent"];
  else if (project.mode !== undefined) [mode, modeFrom] = [project.mode, "project"];
  const quiet = mode === "quiet" && !(modeFrom === "global" && globalMode === null);
  const isChild = up.length > 0;
  let voiceChildren = false;
  let childrenFrom: ResolvedVoice["childrenFrom"] = null;
  if (isChild) {
    const fromAncestor = up.map((id) => data.threads[id]?.voiceChildren).find((v) => v !== undefined);
    if (fromAncestor !== undefined) [voiceChildren, childrenFrom] = [fromAncestor, "parent"];
    else if (project.voiceChildren !== undefined) [voiceChildren, childrenFrom] = [project.voiceChildren, "project"];
  }
  const voiced = !quiet && (!isChild || own.mode !== undefined || voiceChildren);
  return { mode, voiced, modeFrom, isChild, childrenFrom };
}

function applyPatch(current: ScopeSetting | undefined, patch: ScopePatch): ScopeSetting | undefined {
  const next: ScopeSetting = { ...current };
  if ("mode" in patch) {
    if (patch.mode == null) delete next.mode;
    else next.mode = patch.mode;
  }
  if ("voiceChildren" in patch) {
    if (patch.voiceChildren == null) delete next.voiceChildren;
    else next.voiceChildren = patch.voiceChildren;
  }
  return Object.keys(next).length ? next : undefined;
}

export class VoiceScopes {
  #kv: KvLike;
  #data: ScopesData = { threads: {}, projects: {}, parents: {} };
  #listeners = new Set<(kind: ScopesChange) => void>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(kv: KvLike) {
    this.#kv = kv;
  }

  async load(): Promise<ScopesData> {
    const settings = await this.#kv.get<unknown>(SETTINGS_KEY);
    const parents = await this.#kv.get<unknown>(PARENTS_KEY);
    this.#data = {
      threads: settingsOf(isRecord(settings) ? settings.threads : undefined),
      projects: settingsOf(isRecord(settings) ? settings.projects : undefined),
      parents: parentsOf(isRecord(parents) ? parents.parents : undefined),
    };
    return this.#data;
  }

  get(): ScopesData {
    return this.#data;
  }

  parentOf(threadId: string): string | undefined {
    return this.#data.parents[threadId];
  }

  async set(scope: "thread" | "project", id: string, patch: ScopePatch): Promise<ScopesData> {
    await this.#write((d) => {
      const table = scope === "thread" ? d.threads : d.projects;
      const next = applyPatch(table[id], patch);
      if (next) table[id] = next;
      else delete table[id];
      return ["settings"];
    });
    return this.#data;
  }

  async learnParent(threadId: string, parentThreadId: string | null | undefined): Promise<void> {
    if (!parentThreadId || this.#data.parents[threadId] === parentThreadId) return;
    await this.#write((d) => {
      if (d.parents[threadId] === parentThreadId) return [];
      delete d.parents[threadId];
      d.parents[threadId] = parentThreadId;
      const ids = Object.keys(d.parents);
      for (const old of ids.slice(0, Math.max(0, ids.length - MAX_PARENTS))) delete d.parents[old];
      return ["parents"];
    });
  }

  async forget(threadId: string): Promise<void> {
    await this.#write((d) => {
      const kinds: ScopesChange[] = [];
      if (threadId in d.threads) {
        delete d.threads[threadId];
        kinds.push("settings");
      }
      if (threadId in d.parents) {
        delete d.parents[threadId];
        kinds.push("parents");
      }
      return kinds;
    });
  }

  onChange(listener: (kind: ScopesChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Applies one edit at a time, in call order, on the last committed data.
   * The edit returns which parts it changed; only those keys are written, and
   * the in-memory data changes only after every write succeeded.
   */
  #write(edit: (draft: ScopesData) => ScopesChange[]): Promise<void> {
    const run = async () => {
      const draft = structuredClone(this.#data);
      const kinds = edit(draft);
      if (kinds.includes("settings")) await this.#kv.set(SETTINGS_KEY, { threads: draft.threads, projects: draft.projects });
      if (kinds.includes("parents")) await this.#kv.set(PARENTS_KEY, { parents: draft.parents });
      if (!kinds.length) return;
      this.#data = draft;
      for (const kind of kinds) for (const l of this.#listeners) l(kind);
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
