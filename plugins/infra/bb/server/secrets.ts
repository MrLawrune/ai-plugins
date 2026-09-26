// Connection credentials live in BB's native secret storage: one secret setting holding
// { [connectionId]: { secret } } as JSON. Never returned to the frontend.
export interface SecretSettingsHandle {
  get(): Promise<{ credentials?: string }>;
  experimental_set(v: { credentials: string | null }): Promise<unknown>;
}

type CredentialMap = Record<string, { secret: string }>;

function parse(raw: string | undefined): CredentialMap {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as CredentialMap) : {};
  } catch {
    return {};
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
    return this.update((m) => { m[connectionId] = { secret }; });
  }

  remove(connectionId: string): Promise<void> {
    return this.update((m) => { delete m[connectionId]; });
  }
}
