// Connection credentials live in BB's native secret storage: one secret setting holding
// { [connectionId]: { secret, actionSecret? } } as JSON. Never returned to the frontend.
export interface SecretSettingsHandle {
  get(): Promise<{ credentials?: string }>;
  experimental_set(v: { credentials: string | null }): Promise<unknown>;
}

type CredentialMap = Record<string, { secret: string; actionSecret?: string }>;

function parse(raw: string | undefined): CredentialMap {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as CredentialMap) : {};
  } catch {
    return {};
  }
}

/** Accepts only what this module writes, so a hand edit in the settings UI cannot corrupt stored credentials. */
export function isCredentialMap(raw: string): boolean {
  if (raw === "") return true;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    return Object.values(v).every((e) => {
      if (!e || typeof e !== "object") return false;
      const x = e as { secret?: unknown; actionSecret?: unknown };
      return typeof x.secret === "string" && (x.actionSecret === undefined || typeof x.actionSecret === "string");
    });
  } catch {
    return false;
  }
}

export class Secrets {
  private readonly handle: SecretSettingsHandle;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(handle: SecretSettingsHandle) {
    this.handle = handle;
  }

  private async read(): Promise<CredentialMap> {
    return parse((await this.handle.get()).credentials);
  }

  /** Serialize read-modify-write so concurrent saves never drop each other. */
  private update(mutate: (m: CredentialMap) => void): Promise<void> {
    const next = this.chain.then(async () => {
      const m = await this.read();
      mutate(m);
      await this.handle.experimental_set({ credentials: Object.keys(m).length ? JSON.stringify(m) : null });
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async get(connectionId: string): Promise<string | null> {
    await this.chain;
    const v = (await this.read())[connectionId]?.secret;
    return typeof v === "string" && v !== "" ? v : null;
  }

  async has(connectionId: string): Promise<boolean> {
    return (await this.get(connectionId)) !== null;
  }

  set(connectionId: string, secret: string): Promise<void> {
    return this.update((m) => { m[connectionId] = { ...m[connectionId], secret }; });
  }

  async getAction(connectionId: string): Promise<string | null> {
    await this.chain;
    const v = (await this.read())[connectionId]?.actionSecret;
    return typeof v === "string" && v !== "" ? v : null;
  }

  async hasAction(connectionId: string): Promise<boolean> {
    return (await this.getAction(connectionId)) !== null;
  }

  /** Requires a main secret to exist first (the map entry needs `secret`). */
  setAction(connectionId: string, actionSecret: string): Promise<void> {
    return this.update((m) => {
      if (!m[connectionId]) throw new Error("save the connection's main credential first");
      m[connectionId] = { ...m[connectionId], actionSecret };
    });
  }

  removeAction(connectionId: string): Promise<void> {
    return this.update((m) => { if (m[connectionId]) delete m[connectionId].actionSecret; });
  }

  remove(connectionId: string): Promise<void> {
    return this.update((m) => { delete m[connectionId]; });
  }
}
