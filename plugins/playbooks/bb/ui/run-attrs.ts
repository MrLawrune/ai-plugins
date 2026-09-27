// ::playbook-run attributes are model-written and untrusted: accept only a well-formed run id.
const RUN_ID_RE = /^run_[0-9A-Za-z]{6,32}$/;

export function parseRunAttrs(attrs: Readonly<Record<string, string>>): { id: string } | null {
  const { id } = attrs;
  return id !== undefined && RUN_ID_RE.test(id) ? { id } : null;
}
