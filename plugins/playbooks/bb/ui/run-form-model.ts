// Pure model behind the run form: form state <-> RunSpec, validation, apply gating, and the payload check.
import { PROD_APPLY_REASON } from "../server/policy.ts";
import { isSafeRelativePath } from "../server/targets.ts";
import { ENV_KINDS } from "../shared/constants.ts";
import type { EnvBadgeDto, RunSpec } from "../shared/types.ts";

export interface FormState {
  inventory: string; limit: string; tags: string; skipTags: string;
  extraVars: { key: string; value: string }[];
  credRefId: string | null; check: boolean; verbosity: RunSpec["verbosity"]; branch: string | null; typed: string;
}
export interface RunPolicy { applyAllowed: boolean; applyNeedsTyped: boolean; phrase: string | null; blockedReason?: string | null }
export interface RunFormData {
  env: EnvBadgeDto; playbook: string; summaryLine: string; spec: RunSpec; policy: RunPolicy;
  inventories: string[]; credRefs: { id: string; name: string }[];
}
export type FormErrors = Partial<Record<"limit" | "inventory" | "extraVars" | "tags" | "skipTags" | "branch", string>>;

export const LIMIT_MAX = 200;
const VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const splitList = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);

export function initialState(spec: RunSpec): FormState {
  return {
    inventory: spec.inventory, limit: spec.limit, tags: spec.tags.join(", "), skipTags: spec.skipTags.join(", "),
    extraVars: Object.entries(spec.extraVars).map(([key, v]) => ({ key, value: typeof v === "string" ? v : JSON.stringify(v) })),
    credRefId: spec.credRefId, check: spec.check, verbosity: spec.verbosity, branch: spec.branch, typed: "",
  };
}

const looksJson = (v: string) => /^[[{"]/.test(v) || /^(true|false|null|-?\d+(\.\d+)?)$/.test(v);
function parseValue(v: string): unknown {
  const t = v.trim();
  if (!looksJson(t)) return v;
  try { return JSON.parse(t); } catch { return v; }
}

export function validate(s: FormState): FormErrors {
  const e: FormErrors = {};
  if (s.limit.length > LIMIT_MAX) e.limit = `limit is at most ${LIMIT_MAX} characters`;
  if (s.inventory.trim() && !isSafeRelativePath(s.inventory.trim())) e.inventory = "use a relative path without .. or a leading /";
  const orphan = s.extraVars.find((r) => r.key.trim() === "" && r.value !== "");
  const bad = s.extraVars.find((r) => r.key.trim() !== "" && !VAR_KEY.test(r.key.trim()));
  if (orphan) e.extraVars = "an extra variable has a value but no name";
  else if (bad) e.extraVars = `"${bad.key}" is not a valid variable name (letters, digits, underscore; not starting with a digit)`;
  else {
    const keys = s.extraVars.map((r) => r.key.trim()).filter(Boolean);
    if (new Set(keys).size !== keys.length) e.extraVars = "extra variable names must be unique";
  }
  if (splitList(s.tags).length > 50) e.tags = "at most 50 tags";
  if (splitList(s.skipTags).length > 50) e.skipTags = "at most 50 tags";
  return e;
}

/** Check mode always shows the diff. */
export function toSpec(s: FormState): RunSpec {
  const extraVars: Record<string, unknown> = {};
  for (const r of s.extraVars) { const k = r.key.trim(); if (k) extraVars[k] = parseValue(r.value); }
  return {
    inventory: s.inventory.trim(), limit: s.limit.trim(), tags: splitList(s.tags), skipTags: splitList(s.skipTags), extraVars,
    credRefId: s.credRefId, check: s.check, diff: s.check, verbosity: s.verbosity, branch: s.branch,
  };
}

/** Why Apply (a non-check run) cannot go ahead, or null when it can. */
export function applyDisabledReason(policy: RunPolicy, s: Pick<FormState, "check" | "typed">, fallbackPhrase?: string): string | null {
  if (s.check) return null;
  if (!policy.applyAllowed) return policy.blockedReason ?? PROD_APPLY_REASON;
  const phrase = policy.phrase ?? fallbackPhrase ?? null;
  if (policy.applyNeedsTyped && (phrase === null || s.typed !== phrase)) return `type ${phrase ?? "the playbook name"} to confirm`;
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function specOf(v: unknown): RunSpec | null {
  if (!isObj(v)) return null;
  if (!isStr(v.inventory) || !isStr(v.limit) || !strList(v.tags) || !strList(v.skipTags) || !isObj(v.extraVars)) return null;
  if (!(v.credRefId === null || isStr(v.credRefId)) || typeof v.check !== "boolean" || typeof v.diff !== "boolean") return null;
  if (![0, 1, 2, 3, 4].includes(v.verbosity as number) || !(v.branch === null || isStr(v.branch))) return null;
  return v as unknown as RunSpec;
}

/** Structural check of the untrusted interaction payload; null when malformed. */
export function fromPayload(p: unknown): RunFormData | null {
  if (!isObj(p)) return null;
  const env = p.env, pol = p.policy;
  if (!isObj(env) || !isStr(env.slug) || !isStr(env.name) || !isStr(env.color) || !(ENV_KINDS as readonly unknown[]).includes(env.kind)) return null;
  if (!isStr(p.playbook) || !isStr(p.summaryLine)) return null;
  const spec = specOf(p.spec);
  if (!spec) return null;
  if (!isObj(pol) || typeof pol.applyAllowed !== "boolean" || typeof pol.applyNeedsTyped !== "boolean" || !(pol.phrase === null || isStr(pol.phrase)) || !(pol.blockedReason === undefined || pol.blockedReason === null || isStr(pol.blockedReason))) return null;
  if (!strList(p.inventories)) return null;
  if (!Array.isArray(p.credRefs) || !p.credRefs.every((c) => isObj(c) && isStr(c.id) && isStr(c.name))) return null;
  return p as unknown as RunFormData;
}
