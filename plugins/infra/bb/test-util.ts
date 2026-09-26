// Shared test helpers.
import { readFileSync } from "node:fs";

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, type SqlDb } from "./server/store.ts";

/** In-memory database with the store's migrations applied (node:sqlite stands in for the host's better-sqlite3). */
export function memDb(): SqlDb {
  const db = new DatabaseSync(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db as unknown as SqlDb;
}

import type { GuestDetail, GuestState, HostState, InfraProvider, Inventory } from "./server/providers/types.ts";

export function host(node: string, over: Partial<HostState> = {}): HostState {
  return { node, online: true, cpu: 0.1, maxcpu: 8, mem: 1, maxmem: 2, disk: 1, maxdisk: 4, uptime: 100, ip: null, ...over };
}

export function guest(node: string, vmid: number, over: Partial<GuestState> = {}): GuestState {
  return { node, vmid, type: "lxc", name: `ct${vmid}`, state: "running", cpu: 0, maxcpu: 1, mem: 1, maxmem: 2, disk: 1, maxdisk: 2, uptime: 10, tags: [], template: false, ...over };
}

export function inv(hosts: HostState[], guests: GuestState[] = []): Inventory {
  return { hosts, guests, storage: [] };
}

/** Provider returning scripted inventories (or throwing scripted errors); the last entry repeats. */
export function fakeProvider(script: (Inventory | Error)[], details: Record<string, Partial<GuestDetail>> = {}): InfraProvider & { calls: number } {
  const p = {
    kind: "proxmox" as const,
    calls: 0,
    async inventory() {
      const r = script[Math.min(p.calls, script.length - 1)]!;
      p.calls++;
      if (r instanceof Error) throw r;
      return structuredClone(r);
    },
    async hostDetail(): Promise<never> { throw new Error("not scripted"); },
    async guestDetail(ref: { node: string; vmid: number }) {
      const d = details[`${ref.node}/${ref.vmid}`];
      if (!d) throw new Error("no detail");
      const last = script.filter((x): x is Inventory => !(x instanceof Error)).at(-1);
      const g = last?.guests.find((x) => x.node === ref.node && x.vmid === ref.vmid) ?? guest(ref.node, ref.vmid);
      return { guest: structuredClone(g), hostname: null, os: null, interfaces: [], config: {}, notes: "", snapshots: [], agent: "n/a" as const, ...d };
    },
    async metrics(): Promise<never> { throw new Error("not scripted"); },
    async tasks() { return []; },
    async backups() { return []; },
    webUrl() { return "https://pve.test:8006/"; },
    async version() { return "9.1.4"; },
  };
  return p;
}

import type { EnvSnapshot } from "./server/hub.ts";
import type { EnvKind, InfraEnvRow } from "./server/store.ts";

export function envRow(slug: string, kind: EnvKind = "lab", over: Partial<InfraEnvRow> = {}): InfraEnvRow {
  return { id: `id-${slug}`, slug, name: slug[0]!.toUpperCase() + slug.slice(1), kind, color: "#22c55e", pollSeconds: 10, rules: "", exportDir: "", createdAt: 0, ipRefreshMinutes: 5, conventionsPath: "", ...over };
}

export function snapshotOf(env: InfraEnvRow, hosts: HostState[], guests: GuestState[] = []): EnvSnapshot {
  return {
    env,
    hosts: hosts.map((h) => ({ ...h, connectionId: "c1" })),
    guests: guests.map((g) => ({ ...g, connectionId: "c1" })),
    storage: [],
    connections: [{ id: "c1", label: "c1", health: { code: "ok", message: null, lastOkAt: 1, staleSince: null } }],
    updatedAt: 1,
  };
}

import { Activity } from "./server/activity.ts";
import { Hub } from "./server/hub.ts";
import { Pins } from "./server/pins.ts";
import { Secrets } from "./server/secrets.ts";
import { InfraService } from "./server/service.ts";
import { Store as StoreClass } from "./server/store.ts";

/** A fully wired service over scripted providers, keyed by connection label. */
export async function serviceHarness(envs: { slug: string; kind?: EnvKind; rules?: string; conns: Record<string, InfraProvider> }[]) {
  let t = 1_000_000;
  const store = new StoreClass(memDb(), () => t);
  const providers = new Map<string, InfraProvider>();
  for (const e of envs) {
    const env = store.upsertEnv({ slug: e.slug, name: e.slug[0]!.toUpperCase() + e.slug.slice(1), kind: e.kind ?? "lab", color: "#22c55e", pollSeconds: 10, rules: e.rules ?? "", exportDir: "" });
    for (const [label, p] of Object.entries(e.conns)) {
      const c = store.upsertConnection({ envId: env.id, label, baseUrl: `https://${label}:8006`, authKind: "token", username: "u@pve!t", tlsMode: "insecure", tlsFingerprint: "", caPem: "", enabled: true });
      providers.set(c.id, p);
    }
  }
  const secretValue = { v: undefined as string | undefined };
  const secrets = new Secrets({ async get() { return { credentials: secretValue.v }; }, async experimental_set(x) { secretValue.v = x.credentials ?? undefined; return {}; } });
  const hub: Hub = new Hub({
    store, now: () => t, log: () => undefined, onChange: () => undefined, onSnapshot: () => undefined,
    providerFor: async (c) => providers.get(c.id) ?? fakeProvider([inv([])]),
  });
  const pageBox: { pages: import("./server/activity.ts").RawEvent[][] } = { pages: [] };
  const activity = new Activity({
    store, now: () => t, onActivity: () => undefined,
    events: { async list() { return pageBox.pages.shift() ?? []; } },
    index: () => (globalThis as { __infraIndex?: import("./server/matcher.ts").MatchIndex }).__infraIndex!,
    envIdForSlug: (slug) => store.getEnvBySlug(slug)?.id ?? null,
  });
  const pins = new Pins(store, () => t);
  let reloads = 0;
  const service = new InfraService({
    store, hub, activity, pins, secrets, now: () => t,
    probe: async (u) => { if (u.includes("bad")) throw new Error("ECONNREFUSED"); return { fingerprint256: "AA:BB", subject: "pve", issuer: "pve", validTo: "2030" }; },
    onConfigChanged: async () => { reloads++; await hub.reload(); },
  });
  await hub.reload();
  for (const c of store.listConnections()) await hub.tick(c.id, new AbortController().signal);
  const { buildIndex } = await import("./server/matcher.ts");
  (globalThis as { __infraIndex?: unknown }).__infraIndex = buildIndex(hub.snapshots(), new Map([["pve1", "pve1"]]), hub.guestIps());
  return { service, store, hub, activity, pins, secrets, secretValue, pageBox, reloads: () => reloads, advance: (ms: number) => { t += ms; }, now: () => t };
}
