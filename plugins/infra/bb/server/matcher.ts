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

/** Values a shell variable can take in this command: `for v in a b c; do` loops and `v=value` assignments. */
function variables(command: string): Map<string, string[]> {
  const vars = new Map<string, string[]>();
  for (const m of command.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n]+?)\s*(?:;|\n)\s*do\b/g)) vars.set(m[1]!, words(m[2]!));
  for (const m of command.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=(?:"([^"$`]*)"|'([^']*)'|([^\s;&|'"$`]+))/g)) {
    const v = m[2] ?? m[3] ?? m[4] ?? "";
    if (v && !/\s/.test(v)) vars.set(m[1]!, [v]);
  }
  return vars;
}

/** `$h` / `${h}` expand to the variable's possible values; anything else is itself. */
function expand(word: string, vars: Map<string, string[]>): string[] {
  const m = word.match(/^([^$]*)\$\{?([A-Za-z_]\w*)\}?(.*)$/);
  if (!m) return [word];
  return (vars.get(m[2]!) ?? []).map((v) => `${m[1]}${v}${m[3]}`);
}

/** Hosts named as the destination of ssh/mosh, or as the remote side of scp/rsync (`host:path`). */
function remoteDestinations(command: string): string[] {
  const vars = variables(command);
  const w = words(command);
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const cmd = w[i]!.split("/").pop();
    if (cmd === "ssh" || cmd === "mosh") {
      for (let j = i + 1; j < w.length; j++) {
        const t = w[j]!;
        if (t.startsWith("-")) { if (SSH_ARG_OPTS.has(t)) j++; continue; }
        for (const d of expand(t, vars)) out.push(stripUser(d).toLowerCase());
        break;
      }
    } else if (cmd === "scp" || cmd === "rsync" || cmd === "sftp") {
      for (const t of w.slice(i + 1).flatMap((x) => expand(x, vars))) {
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

/** Programs whose arguments name a machine to talk to. Anything else (grep, git, echo) only mentions names. */
const NET_TOOLS = new Set([
  "curl", "wget", "http", "https", "xh", "ping", "ping6", "arping", "nc", "ncat", "netcat", "telnet", "nmap", "mtr", "traceroute", "tracepath",
  "dig", "host", "nslookup", "ssh-keyscan", "ssh-copy-id", "openssl", "grpcurl", "websocat", "iperf3", "psql", "mysql", "mariadb", "redis-cli",
  "mongosh", "ftp", "lftp", "smbclient", "showmount",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** Words with quotes removed, plus shell operators as their own tokens so each simple command can be told apart. */
function shellTokens(command: string): { word: string; op: boolean }[] {
  const out: { word: string; op: boolean }[] = [];
  const re = /'([^']*)'|"([^"]*)"|(&&|\|\||[|;&\n])|([^\s'"|;&]+)/g;
  for (let m = re.exec(command); m; m = re.exec(command)) {
    if (m[3] !== undefined) out.push({ word: m[3], op: true });
    else out.push({ word: m[1] ?? m[2] ?? m[4]!, op: false });
  }
  return out;
}

/** Tokens that sit in argument position of a network tool, including `sh -c "..."` bodies. */
function networkArgs(command: string, depth = 0): string[] {
  const out: string[] = [];
  let net = false;
  const t = shellTokens(command);
  for (let i = 0; i < t.length; i++) {
    const { word, op } = t[i]!;
    if (op) { net = false; continue; }
    const cmd = word.split("/").pop()!;
    if (NET_TOOLS.has(cmd)) { net = true; continue; }
    if (SHELLS.has(cmd) && t[i + 1]?.word === "-c" && t[i + 2] && depth < 2) { out.push(...networkArgs(t[i + 2]!.word, depth + 1)); i += 2; continue; }
    if (net) out.push(...tokens(word));
  }
  return out;
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

  for (const t of networkArgs(command)) {
    addHosts(idx.hostsByName.get(t.toLowerCase()));
    addHosts(idx.hostsByIp.get(t));
    addGuests(idx.guestsByIp.get(t));
  }
  const shellBodies = shellTokens(command).flatMap((t, i, all) => (SHELLS.has(t.word.split("/").pop()!) && all[i + 1]?.word === "-c" && all[i + 2] ? [all[i + 2]!.word] : []));
  for (const dest of [...remoteDestinations(command), ...shellBodies.flatMap(remoteDestinations)]) {
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
