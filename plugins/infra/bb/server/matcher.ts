// Attribute agent shell commands to infrastructure targets. Conservative by design:
// a false "agent touched prod" is worse than a missed attribution.
import type { EnvSnapshot } from "./hub.ts";

export type HostRef = { envSlug: string; node: string };
export type GuestRef = { envSlug: string; node: string; vmid: number };

export interface MatchIndex {
  hostsByName: Map<string, HostRef[]>;
  hostsByIp: Map<string, HostRef[]>;
  guestsByName: Map<string, GuestRef[]>;
  guestsByIp: Map<string, GuestRef[]>;
  guestsByHostVmid: Map<string, GuestRef>;
  aliases: Map<string, string>;
}

const push = <T>(m: Map<string, T[]>, k: string, v: T) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
const hostKey = (envSlug: string, node: string) => `${envSlug}/${node.toLowerCase()}`;

export function buildIndex(snaps: EnvSnapshot[], sshAliases: ReadonlyMap<string, string>, guestIps: ReadonlyMap<string, string[]>): MatchIndex {
  const idx: MatchIndex = { hostsByName: new Map(), hostsByIp: new Map(), guestsByName: new Map(), guestsByIp: new Map(), guestsByHostVmid: new Map(), aliases: new Map(sshAliases) };
  for (const s of snaps) {
    const slug = s.env.slug;
    for (const h of s.hosts) {
      const ref = { envSlug: slug, node: h.node };
      push(idx.hostsByName, h.node.toLowerCase(), ref);
      if (h.ip) push(idx.hostsByIp, h.ip, ref);
    }
    for (const g of s.guests) {
      const ref = { envSlug: slug, node: g.node, vmid: g.vmid };
      idx.guestsByHostVmid.set(`${hostKey(slug, g.node)}/${g.vmid}`, ref);
      if (g.name.length >= 3) push(idx.guestsByName, g.name.toLowerCase(), ref);
      for (const ip of guestIps.get(`${slug}/${g.node}/${g.vmid}`) ?? []) push(idx.guestsByIp, ip, ref);
    }
  }
  return idx;
}

const SSH_ARG_OPTS = new Set(["-p", "-i", "-o", "-l", "-J", "-F", "-E", "-b", "-c", "-D", "-L", "-R", "-W", "-w", "-e", "-m", "-O", "-Q", "-S", "-B", "-P"]);

/** Shell-ish words: whitespace split with quotes removed (quoted remote commands stay one word). */
function words(command: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (let m = re.exec(command); m; m = re.exec(command)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

const stripUser = (s: string) => s.slice(s.lastIndexOf("@") + 1);

/** Hosts named as the destination of ssh/mosh, or as the remote side of scp/rsync (`host:path`). */
function remoteDestinations(command: string): string[] {
  const w = words(command);
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const cmd = w[i]!.split("/").pop();
    if (cmd === "ssh" || cmd === "mosh") {
      for (let j = i + 1; j < w.length; j++) {
        const t = w[j]!;
        if (t.startsWith("-")) { if (SSH_ARG_OPTS.has(t)) j++; continue; }
        out.push(stripUser(t).toLowerCase());
        break;
      }
    } else if (cmd === "scp" || cmd === "rsync" || cmd === "sftp") {
      for (const t of w.slice(i + 1)) {
        const m = t.match(/^([^/\s:]+):/);
        if (m && !t.startsWith("-")) out.push(stripUser(m[1]!).toLowerCase());
      }
    }
  }
  return out;
}

function tokens(command: string): string[] {
  return command.split(/[\s'"`;|&()<>=,@:[\]{}]+/).map((t) => t.replace(/^\/+|\/+$/g, "")).filter(Boolean);
}

const fmtHost = (h: HostRef) => `${h.envSlug}/${h.node}`;
const fmtGuest = (g: GuestRef) => `${g.envSlug}/${g.node}/${g.vmid}`;

/** Heredoc bodies are data (file contents, scripts piped to other programs), not commands this shell runs. */
export function stripHeredocs(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let end: { word: string; dash: boolean } | null = null;
  for (const line of lines) {
    if (end) {
      if ((end.dash ? line.replace(/^\t+/, "") : line).trim() === end.word) end = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (m) end = { word: m[3]!, dash: m[1] === "-" };
  }
  return out.join("\n");
}

export function matchCommand(rawCommand: string, idx: MatchIndex): string[] {
  const command = stripHeredocs(rawCommand);
  const hosts = new Map<string, HostRef>();
  const guests = new Map<string, GuestRef>();
  const addHosts = (l?: HostRef[]) => l?.forEach((h) => hosts.set(fmtHost(h), h));
  const addGuests = (l?: GuestRef[]) => l?.forEach((g) => guests.set(fmtGuest(g), g));

  const resolveName = (name: string) => {
    const target = idx.aliases.get(name) ?? name;
    addHosts(idx.hostsByName.get(target) ?? idx.hostsByIp.get(target));
    addGuests(idx.guestsByIp.get(target));
  };

  for (const t of tokens(command)) {
    const lower = t.toLowerCase();
    addHosts(idx.hostsByName.get(lower));
    addHosts(idx.hostsByIp.get(t));
    addGuests(idx.guestsByIp.get(t));
  }
  for (const dest of remoteDestinations(command)) {
    resolveName(dest);
    addGuests(idx.guestsByName.get(dest));
  }
  for (const m of command.matchAll(/\/nodes\/([A-Za-z0-9.-]+)/g)) addHosts(idx.hostsByName.get(m[1]!.toLowerCase()));

  if (hosts.size === 1) {
    const h = [...hosts.values()][0]!;
    const vmids = new Set<number>();
    for (const m of command.matchAll(/\b(?:pct|qm)\s+[a-z-]+\s+(\d{1,9})\b/g)) vmids.add(Number(m[1]));
    for (const m of command.matchAll(/\/(?:lxc|qemu)\/(\d{1,9})\b/g)) vmids.add(Number(m[1]));
    for (const vmid of vmids) {
      const g = idx.guestsByHostVmid.get(`${hostKey(h.envSlug, h.node)}/${vmid}`);
      if (g) guests.set(fmtGuest(g), g);
    }
  }
  return [...hosts.keys(), ...guests.keys()].sort();
}
