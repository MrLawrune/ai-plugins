// Environment management: CRUD over the store, plus a cached health probe of each control host (spec §6.1).
// Phase 1 is SSH-only, so `controlHost: "local"` is rejected on save.
import { posix } from "node:path";
import type { EnvBadgeDto, EnvHealthCode } from "../shared/types.ts";
import type { EnvInput, PlaybooksEnvRow, Store } from "./store.ts";
import type { HostClient } from "./runs.ts";

export interface EnvHealth { code: EnvHealthCode; message: string | null; ansible: string | null; runner: string | null; python3: string | null; head: string | null; playbooks: number }

const SETTINGS_PATH = "Settings → Plugins → Playbooks → Environments";

/** The nudge shown until at least one environment answers its probe; an environment not probed yet is not a gap. */
export function configurationGap(envs: PlaybooksEnvRow[], health: ReadonlyMap<string, EnvHealth>): string | null {
  if (envs.length === 0) return `Add an environment in ${SETTINGS_PATH}.`;
  const states = envs.map((e) => ({ env: e, h: health.get(e.id) }));
  if (states.some((s) => !s.h || s.h.code === "ok")) return null;
  return `Fix the connection for ${states[0]!.env.name} in ${SETTINGS_PATH}.`;
}

/**
 * The inventory root as a path relative to the repository ("" when it is the repository itself; an empty root means
 * the repository), or null when it lies outside the repository. Discovered inventories are prefixed with it so every
 * inventory path the plugin stores or runs with is repo-relative.
 */
export function inventoryPrefix(repoPath: string, inventoryRoot: string): string | null {
  const repo = posix.resolve(repoPath);
  const root = inventoryRoot.trim() === "" ? repo : posix.resolve(inventoryRoot.trim());
  const rel = posix.relative(repo, root);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) return null;
  return rel;
}

export interface EnvServiceDeps { store: Store; host: HostClient; now(): number; primaryHostId: string }

export class EnvService {
  private readonly d: EnvServiceDeps;
  private readonly healthById = new Map<string, EnvHealth>();

  constructor(d: EnvServiceDeps) {
    this.d = d;
  }

  list(): PlaybooksEnvRow[] {
    return this.d.store.listEnvs();
  }

  get(idOrSlug: string): PlaybooksEnvRow | null {
    return this.d.store.getEnv(idOrSlug) ?? this.d.store.getEnvBySlug(idOrSlug);
  }

  save(input: EnvInput): PlaybooksEnvRow {
    if (input.controlHost === "local") throw new Error('controlHost "local" is not supported yet; use an ssh alias or host name');
    // An empty inventory folder means the repository; anything else must sit inside it so inventory paths stay repo-relative.
    const inventoryRoot = input.inventoryRoot.trim() === "" ? input.repoPath : input.inventoryRoot.trim();
    if (inventoryPrefix(input.repoPath, inventoryRoot) === null) throw new Error(`inventory folder ${inventoryRoot} must be inside the repository path ${input.repoPath}`);
    const row = this.d.store.upsertEnv({ ...input, inventoryRoot });
    this.healthById.delete(row.id);
    return row;
  }

  /** Refused while the environment has open runs (they could not be cancelled or reconciled afterwards); finished runs stay as history. */
  delete(id: string): void {
    const open = this.d.store.listOpenRuns().filter((r) => r.envId === id).length;
    if (open > 0) throw new Error(`environment has ${open} open run${open === 1 ? "" : "s"}; wait for or cancel ${open === 1 ? "it" : "them"} first`);
    this.d.store.deleteEnv(id);
    this.healthById.delete(id);
  }

  /** Last probe result, or null when the environment has not been tested since it was saved. */
  health(id: string): EnvHealth | null {
    return this.healthById.get(id) ?? null;
  }

  /** The cache as `configurationGap` wants it. */
  healthMap(): ReadonlyMap<string, EnvHealth> {
    return this.healthById;
  }

  badge(env: PlaybooksEnvRow): EnvBadgeDto {
    return { slug: env.slug, name: env.name, kind: env.kind, color: env.color };
  }

  async test(id: string): Promise<EnvHealth> {
    const env = this.d.store.getEnv(id);
    if (!env) throw new Error(`unknown environment ${id}`);
    const h = await this.probe(env);
    this.healthById.set(id, h);
    return h;
  }

  private async probe(env: PlaybooksEnvRow): Promise<EnvHealth> {
    const blank: EnvHealth = { code: "ok", message: null, ansible: null, runner: null, python3: null, head: null, playbooks: 0 };
    if (!env.enabled) return { ...blank, code: "disabled", message: "Environment is disabled." };
    const opts = { hostId: env.hostId ?? this.d.primaryHostId };
    const input = { controlHost: env.controlHost, repoPath: env.repoPath };
    let p;
    try {
      p = await this.d.host.call("probe", input, opts);
    } catch (e) {
      return { ...blank, code: "unreachable", message: e instanceof Error ? e.message : String(e) };
    }
    const seen = { ansible: p.ansible, runner: p.runner, python3: p.python3, head: p.head };
    if (!p.ansible) return { ...blank, ...seen, code: "no-ansible", message: p.error ?? "ansible was not found on the control host." };
    if (!p.python3) return { ...blank, ...seen, code: "no-ansible", message: p.error ?? "python3 was not found on the control host (the run supervisor needs it)." };
    if (!p.ok) return { ...blank, ...seen, code: "unreachable", message: p.error ?? "probe failed" };
    let paths: string[];
    try {
      paths = (await this.d.host.call("listPlaybooks", input, opts)).paths;
    } catch (e) {
      return { ...blank, ...seen, code: "no-repo", message: e instanceof Error ? e.message : String(e) };
    }
    if (!p.head && paths.length === 0) return { ...blank, ...seen, code: "no-repo", message: `No playbooks or git repository found at ${env.repoPath}.` };
    if (!p.head) return { ...blank, ...seen, playbooks: paths.length, code: "degraded", message: "The repo is not a git checkout; HEAD is unknown." };
    return { ...blank, ...seen, playbooks: paths.length };
  }
}
