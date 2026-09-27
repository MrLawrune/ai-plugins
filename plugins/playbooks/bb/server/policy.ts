// Server-side run policy (spec §6.4): decides, per environment kind, run source, and spec, whether a run may start
// and which confirmation it needs. Pure: no IO, no store access. The service enforces the decision before execute.
import type { CredRefRow, PlaybooksEnvRow } from "./store.ts";
import type { RunSpec } from "../shared/types.ts";

export type RunSource = "card" | "panel" | "page" | "cli" | "tool" | "schedule";

export type Decision =
  | { allowed: true; confirm: "none" | "dialog" | "typed" | "interaction"; phrase: string | null }
  | { allowed: false; reason: string };

export interface DecisionInput {
  env: Pick<PlaybooksEnvRow, "kind" | "agentApproval">;
  spec: RunSpec;
  source: { surface: RunSource; threadId: string | null };
  noConfirm: boolean;
  vaultedInventory: boolean;
  credRef: CredRefRow | null;
}

const AGENT_SURFACES: ReadonlySet<RunSource> = new Set(["cli", "tool"]);
const RELAXED_KINDS: ReadonlySet<PlaybooksEnvRow["kind"]> = new Set(["lab", "dev"]);

export const PROD_APPLY_REASON = "prod environments run in check mode only until a prod-apply template exists";

const allow = (confirm: Extract<Decision, { allowed: true }>["confirm"]): Decision => ({ allowed: true, confirm, phrase: null });
const refuse = (reason: string): Decision => ({ allowed: false, reason });

// Returns the reason a run would block on an interactive prompt, or null. Phase 1 RunSpec carries no raw extra
// args, so only the vault case applies; --ask-pass/--ask-vault-pass/--ask-become-pass checks slot in here later.
export function wouldPrompt(_spec: RunSpec, vaultedInventory: boolean, credRef: CredRefRow | null): string | null {
  if (vaultedInventory && !credRef?.vaultPasswordFile) {
    return "inventory is vault-encrypted and no credential reference names a vault password file";
  }
  return null;
}

export function decide(input: DecisionInput): Decision {
  const { env, spec, source, noConfirm } = input;
  const prompt = wouldPrompt(spec, input.vaultedInventory, input.credRef);
  if (prompt) return refuse(`run would prompt: ${prompt}`);

  // Phase 1 has no templates, so prod is check-mode only for every surface.
  if (env.kind === "prod" && !spec.check) return refuse(PROD_APPLY_REASON);

  if (source.surface === "schedule") return allow("none");

  if (AGENT_SURFACES.has(source.surface)) {
    if (source.threadId === null) {
      // Headless (--no-confirm) mirrors the schedule column: every kind runs direct; prod stays check-only above.
      if (!noConfirm) return refuse("no thread to show the run form in; pass --no-confirm to run headless");
      return allow("none");
    }
    if (RELAXED_KINDS.has(env.kind) && env.agentApproval === "none" && spec.check) return allow("none");
    return allow("interaction");
  }

  // Human surfaces: card, panel, page. The typed phrase guards prod applies only (spec §6.4); prod check runs are direct.
  if (env.kind === "prod") return allow(spec.check ? "none" : "typed");
  if (RELAXED_KINDS.has(env.kind) || spec.check) return allow("none");
  return allow("dialog");
}
