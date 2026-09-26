// Minimal ~/.ssh/config reader: alias → HostName (lowercased). Wildcard patterns and Match blocks are ignored.
export function parseSshConfig(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string[] = [];
  let hostName: string | null = null;
  const flush = () => {
    for (const alias of current) out.set(alias, hostName ?? alias);
    current = [];
    hostName = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(\S+?)\s*(?:=|\s)\s*(.+)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "host") {
      flush();
      current = value.split(/\s+/).filter((a) => !/[*?!]/.test(a)).map((a) => a.toLowerCase());
    } else if (key === "match") {
      flush();
    } else if (key === "hostname" && current.length) {
      hostName = value.toLowerCase();
    }
  }
  flush();
  return out;
}
