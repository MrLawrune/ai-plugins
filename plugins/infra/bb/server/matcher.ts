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

function tokens(command: string): string[] {
  return command.split(/[\s'"`;|&()<>=,@:[\]{}]+/).map((t) => t.replace(/^\/+|\/+$/g, "")).filter(Boolean);
}

/** Programs whose arguments name a machine to talk to. Anything else (grep, git, echo) only mentions names. */
const NET_TOOLS = new Set([
  "curl", "wget", "http", "https", "xh", "ping", "ping6", "arping", "nc", "ncat", "netcat", "telnet", "nmap", "mtr", "traceroute", "tracepath",
  "dig", "host", "nslookup", "ssh-keyscan", "ssh-copy-id", "openssl", "grpcurl", "websocat", "iperf3", "psql", "mysql", "mariadb", "redis-cli",
  "mongosh", "ftp", "lftp", "smbclient", "showmount",
]);
const API_TOOLS = new Set([...NET_TOOLS, "pvesh"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
/** Words that precede the real command of a simple command. */
const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "exec", "command", "builtin", "time", "nice", "stdbuf", "unbuffer"]);
/** Wrapper options that take a value (`sudo -u root`, `env -C dir`), which is not the command. */
const WRAPPER_OPTS_WITH_VALUE = new Set(["-u", "-g", "-U", "-r", "-t", "-C", "-p", "-h", "-T", "-S"]);
/** Shell keywords that can open a simple command. */
const KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{", "("]);

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

interface Simple { cmd: string; args: string[] }

/**
 * The simple commands a shell would run: the program in command position (after wrappers such as
 * sudo/env, keywords, and VAR=value prefixes) with its arguments. `sh -c "…"` bodies are expanded in place,
 * so `echo ssh pve1` is an echo, not an ssh.
 */
function simpleCommands(command: string, depth = 0): Simple[] {
  const out: Simple[] = [];
  let cur: Simple | null = null;
  let start = true;
  const t = shellTokens(command);
  for (let i = 0; i < t.length; i++) {
    const { word, op } = t[i]!;
    if (op) { start = true; cur = null; continue; }
    if (start) {
      if (KEYWORDS.has(word) || /^[A-Za-z_]\w*=/.test(word)) continue;
      const cmd = word.split("/").pop()!;
      if (WRAPPERS.has(cmd) || (cmd === "timeout" && /^\d/.test(t[i + 1]?.word ?? "x"))) { if (cmd === "timeout") i++; continue; }
      if (cmd.startsWith("-")) { if (WRAPPER_OPTS_WITH_VALUE.has(cmd)) i++; continue; } // an option of a wrapper (sudo -u root …)
      start = false;
      if (SHELLS.has(cmd) && t[i + 1]?.word === "-c" && t[i + 2] && !t[i + 2]!.op && depth < 2) {
        out.push(...simpleCommands(t[i + 2]!.word, depth + 1));
        i += 2;
        cur = null;
        continue;
      }
      cur = { cmd, args: [] };
      out.push(cur);
      continue;
    }
    cur?.args.push(word);
  }
  return out;
}

/** Hosts named as the destination of ssh/mosh, or as the remote side of scp/rsync (`host:path`). */
function remoteDestinations(command: string): string[] {
  const vars = variables(command);
  const out: string[] = [];
  for (const { cmd, args } of simpleCommands(command)) {
    if (cmd === "ssh" || cmd === "mosh") {
      for (let j = 0; j < args.length; j++) {
        const a = args[j]!;
        if (a.startsWith("-")) { if (SSH_ARG_OPTS.has(a)) j++; continue; }
        for (const d of expand(a, vars)) out.push(stripUser(d).toLowerCase());
        break;
      }
    } else if (cmd === "scp" || cmd === "rsync" || cmd === "sftp") {
      for (const a of args.flatMap((x) => expand(x, vars))) {
        const m = a.match(/^([^/\s:]+):/);
        if (m && !a.startsWith("-")) out.push(stripUser(m[1]!).toLowerCase());
      }
    }
  }
  return out;
}

/** Tokens in argument position of a network tool. */
function networkArgs(command: string): string[] {
  return simpleCommands(command).filter((c) => NET_TOOLS.has(c.cmd)).flatMap((c) => c.args.flatMap(tokens));
}

/** Proxmox API node names (`/nodes/<node>/…`) in arguments of pvesh or a network tool. */
function apiNodes(command: string): string[] {
  const text = simpleCommands(command).filter((c) => API_TOOLS.has(c.cmd)).flatMap((c) => c.args).join(" ");
  return [...text.matchAll(/\/nodes\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]!.toLowerCase());
}

const REMOTE_TOOLS = new Set(["ssh", "mosh"]);

/** VMIDs named by pct/qm inside a remote command, or by /lxc/<id>, /qemu/<id> in API arguments. */
function guestIds(command: string): number[] {
  const text = simpleCommands(command).filter((c) => REMOTE_TOOLS.has(c.cmd) || API_TOOLS.has(c.cmd)).flatMap((c) => c.args).join(" ");
  const ids = new Set<number>();
  for (const m of text.matchAll(/\b(?:pct|qm)\s+[a-z-]+\s+(\d{1,9})\b/g)) ids.add(Number(m[1]));
  for (const m of text.matchAll(/\/(?:lxc|qemu)\/(\d{1,9})\b/g)) ids.add(Number(m[1]));
  return [...ids];
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
  // A name or address known in more than one place is ambiguous: attributing it everywhere would be wrong somewhere.
  const unique = <T>(l: T[] | undefined): T[] | undefined => (l && l.length === 1 ? l : undefined);
  const addHosts = (l?: HostRef[]) => unique(l)?.forEach((h) => hosts.set(fmtHost(h), h));
  const addGuests = (l?: GuestRef[]) => unique(l)?.forEach((g) => guests.set(fmtGuest(g), g));

  /** An ssh-style destination: alias → address, then host by name or IP, guest by IP; the guest's name only when nothing else knows it. */
  const resolveDestination = (name: string) => {
    const target = idx.aliases.get(name) ?? name;
    const byHost = idx.hostsByName.get(target) ?? idx.hostsByIp.get(target) ?? idx.hostsByName.get(name);
    const byIp = idx.guestsByIp.get(target);
    if (byHost || byIp) { addHosts(byHost); addGuests(byIp); return; }
    addGuests(idx.guestsByName.get(name));
  };

  for (const t of networkArgs(command)) {
    addHosts(idx.hostsByName.get(t.toLowerCase()));
    addHosts(idx.hostsByIp.get(t));
    addGuests(idx.guestsByIp.get(t));
  }
  for (const dest of remoteDestinations(command)) resolveDestination(dest);
  for (const node of apiNodes(command)) addHosts(idx.hostsByName.get(node));

  if (hosts.size === 1) {
    const h = [...hosts.values()][0]!;
    for (const vmid of guestIds(command)) {
      const g = idx.guestsByHostVmid.get(`${hostKey(h.envSlug, h.node)}/${vmid}`);
      if (g) guests.set(fmtGuest(g), g);
    }
  }
  return [...hosts.keys(), ...guests.keys()].sort();
}
