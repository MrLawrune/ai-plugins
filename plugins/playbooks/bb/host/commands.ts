// Pure builders for the shell commands the host entry runs on an environment's Ansible control
// host. Every value that reaches a shell goes through shellQuote; nothing here touches Node APIs.

import { LIMITS } from "../shared/constants.ts";

export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Quote only when a word carries characters a shell (or ansible-runner's shlex) could interpret. */
const quoteIfNeeded = (s: string): string => (/^[A-Za-z0-9_.,:=@%+/-]+$/.test(s) ? s : shellQuote(s));

/** How to run `remote` on `controlHost`: over ssh, or under bash when the control host is this machine. */
export function sshArgs(controlHost: string, remote: string): { cmd: string; args: string[] } {
  return controlHost === "local"
    ? { cmd: "bash", args: ["-lc", remote] }
    : { cmd: "ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", controlHost, remote] };
}

/** Environment variable names the builders accept; the contract enforces the same rule at the boundary. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keys are interpolated bare (they name variables), so an invalid key throws rather than reaching the shell. */
const envPrefix = (e: Record<string, string>): string =>
  Object.entries(e)
    .map(([k, v]) => {
      if (!ENV_KEY_RE.test(k)) throw new Error(`env_key: invalid environment variable name ${JSON.stringify(k)}`);
      return `${k}=${shellQuote(v)}`;
    })
    .join(" ");

/** `cd repo && exec env K=V prog args`: exec keeps the shell's pid, so the pid a launcher records is the program's own. */
const execIn = (repoPath: string, env: Record<string, string>, argv: string[]): string =>
  [`cd ${shellQuote(repoPath)} && exec env`, envPrefix(env), ...argv].filter(Boolean).join(" ");

export const runDirOf = (repoPath: string, ident: string): string => `${repoPath}/.bb-runs/${ident}`;
export const artifactsDirOf = (repoPath: string, ident: string): string => `${runDirOf(repoPath, ident)}/artifacts/${ident}`;
export const streamLogOf = (runDir: string): string => `${runDir}/stream.log`;

export interface RunnerCommandOptions { repoPath: string; ident: string; playbook: string; inventory?: string; cmdline: string[]; envVars: Record<string, string> }

/** ansible-runner with `-j` JSON events; the ansible-playbook flags travel behind `--cmdline=` as one quoted word (the `=` form keeps argparse from reading a leading `--check` as a flag). */
export function runnerCommand(o: RunnerCommandOptions): string {
  const argv = ["ansible-runner run", shellQuote(runDirOf(o.repoPath, o.ident)), "-p", shellQuote(o.playbook), "--project-dir", shellQuote(o.repoPath)];
  if (o.inventory !== undefined) argv.push("--inventory", shellQuote(o.inventory));
  argv.push("-i", shellQuote(o.ident), "-j");
  if (o.cmdline.length) argv.push(`--cmdline=${shellQuote(o.cmdline.map(quoteIfNeeded).join(" "))}`);
  return execIn(o.repoPath, o.envVars, argv);
}

export interface PlaybookCommandOptions { repoPath: string; playbook: string; inventory?: string; cmdline: string[]; envVars: Record<string, string>; mode: "jsonl" | "text" }

/** Plain ansible-playbook, with the ansible.posix.jsonl callback in jsonl mode. Caller env never overrides the output settings. */
export function playbookCommand(o: PlaybookCommandOptions): string {
  const { ANSIBLE_FORCE_COLOR: _color, ANSIBLE_STDOUT_CALLBACK: _callback, ...callerEnv } = o.envVars;
  const env = { ANSIBLE_FORCE_COLOR: "0", ...(o.mode === "jsonl" ? { ANSIBLE_STDOUT_CALLBACK: "ansible.posix.jsonl" } : {}), ...callerEnv };
  const argv = ["ansible-playbook"];
  if (o.inventory !== undefined) argv.push("-i", shellQuote(o.inventory));
  argv.push(...o.cmdline.map(shellQuote), "--", shellQuote(o.playbook));
  return execIn(o.repoPath, env, argv);
}

/** YAML files under the repo minus roles, run artifacts, group/host vars, and .git; `printf`/`%p` are GNU find. */
const PLAYBOOK_FIND = `find . \\( -path '*/roles/*' -o -path '*/.bb-runs/*' -o -path '*/group_vars/*' -o -path '*/host_vars/*' -o -path '*/.git/*' \\) -prune -o \\( -name '*.yml' -o -name '*.yaml' \\) -type f`;

export const findPlaybooksCommand = (repoPath: string): string =>
  `cd ${shellQuote(repoPath)} && ${PLAYBOOK_FIND} -print | sed 's#^\\./##' | sort | head -n ${LIMITS.libraryFiles}`;

/**
 * One `<path>\t<sha256>\t<bytes>` line per playbook file (same set and order as findPlaybooksCommand), so the library
 * learns what changed from a single ssh session and reads only those files. The tab is the field separator (IFS)
 * because paths may contain spaces; `sha256sum <` hashes the bytes readFile hashes as text.
 */
export const hashPlaybooksCommand = (repoPath: string): string =>
  `cd ${shellQuote(repoPath)} && t="$(printf '\\t')" && ${PLAYBOOK_FIND} -printf '%p\\t%s\\n' | sed 's#^\\./##' | sort -t "$t" -k1,1 | head -n ${LIMITS.libraryFiles} | ` +
  `while IFS="$t" read -r p s; do h=$(sha256sum < "$p" 2>/dev/null | cut -c1-64) && printf '%s\\t%s\\t%s\\n' "$p" "$h" "$s"; done`;

/** One `f <path>` or `d <path>` line per entry up to two levels deep; GNU find (`-printf`). A missing root prints nothing. */
export const discoverInventoriesCommand = (root: string): string =>
  `cd ${shellQuote(root)} 2>/dev/null && find -L . -mindepth 1 -maxdepth 2 \\( -name '.*' -o -name group_vars -o -name host_vars \\) -prune -o \\( -type f -o -type d \\) -printf '%y %p\\n' | sed 's#^\\(.\\) \\./#\\1 #' | sort -k2 | head -n 200`;

/** Four `---`-separated sections (ansible, ansible-runner, git HEAD, python3 path); missing tools print nothing, and only an ssh or shell failure makes the exit code non-zero. */
export const probeCommand = (repoPath: string): string =>
  `ansible --version 2>/dev/null | head -n1; echo '---'; ansible-runner --version 2>/dev/null; echo '---'; git -C ${shellQuote(repoPath)} rev-parse --short HEAD 2>/dev/null; echo '---'; command -v python3 2>/dev/null; exit 0`;

export const readFileCommand = (repoPath: string, path: string): string =>
  `cd ${shellQuote(repoPath)} && wc -c < ${shellQuote(path)} && cat ${shellQuote(path)}`;

export const inventoryListCommand = (repoPath: string, inventory: string): string =>
  `cd ${shellQuote(repoPath)} && ansible-inventory -i ${shellQuote(inventory)} --list`;

/**
 * Prints `status`, `---`, `rc`, `---`, the stream.log line count, `---`, and whether the supervisor
 * is alive (`alive` / `dead` / `unknown`, from `kill -0` on the given pid or the run's pid file).
 */
export const runStatusCommand = (repoPath: string, ident: string, pid?: number): string => {
  const p = pid === undefined ? `$(cat ${shellQuote(`${runDirOf(repoPath, ident)}/pid`)} 2>/dev/null)` : String(Math.floor(pid));
  return (
    `d=${shellQuote(artifactsDirOf(repoPath, ident))}; cat "$d/status" 2>/dev/null; echo '---'; cat "$d/rc" 2>/dev/null; echo '---'; ` +
    `wc -l < ${shellQuote(streamLogOf(runDirOf(repoPath, ident)))} 2>/dev/null; echo '---'; ` +
    `p=${p}; if [ -z "$p" ]; then echo unknown; elif kill -0 "$p" 2>/dev/null; then echo alive; else echo dead; fi`
  );
};

export const tailLogCommand = (repoPath: string, ident: string, bytes: number): string =>
  `tail -c ${Math.max(1, Math.floor(bytes))} ${shellQuote(streamLogOf(runDirOf(repoPath, ident)))} 2>/dev/null`;

/** Follow the run's stream.log from a 1-based line number; `-F` survives the file being replaced. */
export const tailStreamCommand = (repoPath: string, ident: string, fromLine: number): string =>
  `tail -n +${Math.max(1, Math.floor(fromLine))} -F ${shellQuote(streamLogOf(runDirOf(repoPath, ident)))}`;

export const killCommand = (pid: number, signal: "INT" | "TERM"): string => `kill -${signal} ${Math.floor(pid)}`;

// The supervisor is the process whose pid startRun returns. It records its pid in <runDir>/pid,
// installs its signal handlers, then runs the inner command as a child with SIGINT restored (an
// asynchronous shell child inherits SIGINT ignored, which would make a plain ansible-playbook
// impossible to interrupt), forwards SIGINT and SIGTERM to that child, and after the child ends
// writes `rc` then `status` into the artifacts directory unless ansible-runner already did. Signal
// deaths are reported shell-style as 128 + signal.
const SUPERVISOR_PY = [
  "import os,signal,subprocess,sys",
  "run_dir,ident,cmd=sys.argv[1:4]",
  "art=os.path.join(run_dir,'artifacts',ident)",
  "os.makedirs(art,exist_ok=True)",
  "with open(os.path.join(run_dir,'pid'),'w') as f: f.write(str(os.getpid()))",
  "state={'p':None,'canceled':False,'sig':None}",
  "def fwd(sig,_):",
  "  state['canceled']=True",
  "  state['sig']=sig",
  "  if state['p'] is not None:",
  "    try: state['p'].send_signal(sig)",
  "    except ProcessLookupError: pass",
  "signal.signal(signal.SIGINT,fwd)",
  "signal.signal(signal.SIGTERM,fwd)",
  "p=subprocess.Popen(['bash','-c',cmd],preexec_fn=lambda: signal.signal(signal.SIGINT,signal.SIG_DFL))",
  "state['p']=p",
  "if state['canceled']:",
  "  try: p.send_signal(state['sig'])",
  "  except ProcessLookupError: pass",
  "rc=p.wait()",
  "if rc<0: rc=128-rc",
  "def put(name,value):",
  "  path=os.path.join(art,name)",
  "  if not os.path.exists(path):",
  "    with open(path,'w') as f: f.write(str(value))",
  "put('rc',rc)",
  "put('status','successful' if rc==0 else ('canceled' if state['canceled'] else 'failed'))",
].join("\n");

export interface SupervisorOptions { runDir: string; ident: string; inner: string }

/** Wrap an inner command (from runnerCommand or playbookCommand) in the status-writing supervisor. */
export const supervisorCommand = (o: SupervisorOptions): string =>
  `exec python3 -c ${shellQuote(SUPERVISOR_PY)} ${shellQuote(o.runDir)} ${shellQuote(o.ident)} ${shellQuote(o.inner)}`;

/**
 * Launch `inner` detached on the control host and print its pid. Only the wrapper is put in the
 * background (the brace group keeps `$!` from naming a subshell around the whole and-list), and
 * setsid + nohup + `bash -c 'exec …'` all exec in place, so the echoed pid is the supervisor's own.
 */
export const detachedLaunchCommand = (runDir: string, inner: string, cwd: string = runDir): string =>
  `mkdir -p ${shellQuote(runDir)} && cd ${shellQuote(cwd)} && { setsid nohup bash -c ${shellQuote(inner)} > ${shellQuote(streamLogOf(runDir))} 2>&1 < /dev/null & echo $!; }`;
