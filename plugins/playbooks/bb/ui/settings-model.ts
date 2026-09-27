// Pure environment-form model: defaults and validation mirroring the rpc schema (bb/schemas.ts envSave).
import type { EnvHealth } from "../schemas.ts";
import { ENV_KINDS, KIND_COLORS, RULES_MAX, type EnvKind } from "../shared/constants.ts";

export interface EnvForm {
  id?: string; slug: string; name: string; kind: EnvKind; color: string; rules: string;
  controlHost: string; hostId: string | null; repoPath: string; inventoryRoot: string;
  runnerKind: "ssh"; agentApproval: "form" | "none"; defaultCheck: boolean; infraEnvSlug: string | null; enabled: boolean;
}
export type EnvFormErrors = Partial<Record<"slug" | "name" | "kind" | "color" | "rules" | "controlHost" | "repoPath" | "inventoryRoot", string>>;

const SLUG = /^[a-z0-9-]{1,32}$/;
export const SLUG_ERROR = "slug must be 1-32 lowercase letters, digits, or dashes";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "env";
}

export function emptyEnvForm(): EnvForm {
  return {
    slug: "", name: "", kind: "lab", color: KIND_COLORS.lab, rules: "", controlHost: "", hostId: null, repoPath: "", inventoryRoot: "",
    runnerKind: "ssh", agentApproval: "form", defaultCheck: true, infraEnvSlug: null, enabled: true,
  };
}

export const canRelaxApproval = (kind: EnvKind): boolean => kind === "lab" || kind === "dev";

export function validateEnvForm(f: Partial<EnvForm>): EnvFormErrors {
  const e: EnvFormErrors = {};
  if (!SLUG.test(f.slug ?? "")) e.slug = SLUG_ERROR;
  if (!(f.name ?? "").trim()) e.name = "name is required";
  if (f.kind !== undefined && !ENV_KINDS.includes(f.kind)) e.kind = "unknown kind";
  if (f.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(f.color)) e.color = "use a #rrggbb colour";
  if ((f.rules ?? "").length > RULES_MAX) e.rules = `rules are limited to ${RULES_MAX} characters`;
  const host = (f.controlHost ?? "").trim();
  if (!host) e.controlHost = "control host is required";
  else if (host === "local") e.controlHost = 'use an ssh alias or host name; "local" is not supported yet';
  if (!(f.repoPath ?? "").startsWith("/")) e.repoPath = "use an absolute path on the control host";
  const inv = f.inventoryRoot ?? "";
  if (inv !== "" && !inv.startsWith("/")) e.inventoryRoot = "use an absolute path or leave empty";
  return e;
}

/** Colour after a kind change: swap the default for the new kind, keep a custom colour; prod is always its red. */
export function colorForKindChange(prevKind: EnvKind, color: string, nextKind: EnvKind): string {
  if (nextKind === "prod" || color.toLowerCase() === KIND_COLORS[prevKind].toLowerCase()) return KIND_COLORS[nextKind];
  return color;
}

/** Test-connection display: the versions line is shown for every health code; the message (if any) goes beneath it. */
export function testResultView(h: EnvHealth): { details: string; message: string | null } {
  const details = `ansible ${h.ansible ?? "?"} · runner ${h.runner ?? "?"} · python3 ${h.python3 ?? "?"} · repo HEAD ${h.head ?? "?"} · ${h.playbooks} playbook${h.playbooks === 1 ? "" : "s"}`;
  return { details, message: h.message ? `${h.code}: ${h.message}` : null };
}

/** A failed test call still yields an EnvHealth, so the UI never has to branch on a bare string. */
export const failedTest = (message: string): EnvHealth => ({ code: "unreachable", message, ansible: null, runner: null, python3: null, head: null, playbooks: 0 });
