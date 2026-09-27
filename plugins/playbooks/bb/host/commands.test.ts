import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detachedLaunchCommand, discoverInventoriesCommand, findPlaybooksCommand, hashPlaybooksCommand, inventoryListCommand, killCommand, playbookCommand, probeCommand,
  readFileCommand, runnerCommand, runStatusCommand, shellQuote, sshArgs, supervisorCommand, tailLogCommand, tailStreamCommand,
} from "./commands.ts";

test("shellQuote never lets metacharacters through", () => {
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("$(rm -rf /)"), `'$(rm -rf /)'`);
  assert.equal(shellQuote(""), "''");
});

test("ssh args for remote and local", () => {
  const r = sshArgs("control", "ls");
  assert.equal(r.cmd, "ssh");
  assert.deepEqual(r.args.slice(-2), ["control", "ls"]);
  assert.ok(r.args.includes("BatchMode=yes") && r.args.includes("ConnectTimeout=10"));
  assert.deepEqual(sshArgs("local", "ls"), { cmd: "bash", args: ["-lc", "ls"] });
});

test("runner command execs ansible-runner with the ansible flags behind --cmdline", () => {
  const c = runnerCommand({ repoPath: "/srv/example", ident: "abc", playbook: "site.yml", inventory: "inventories/staging.yml", cmdline: ["--check", "--diff", "--limit", "web*"], envVars: { ANSIBLE_FORCE_COLOR: "0" } });
  assert.match(c, /^cd '\/srv\/example' && exec env ANSIBLE_FORCE_COLOR='0' ansible-runner run '\/srv\/example\/\.bb-runs\/abc' -p 'site\.yml' --project-dir '\/srv\/example' --inventory 'inventories\/staging\.yml' -i 'abc' -j --cmdline='--check --diff --limit '\\''web\*'\\'''$/);
  const noInv = runnerCommand({ repoPath: "/srv/example", ident: "abc", playbook: "site.yml", cmdline: [], envVars: {} });
  assert.ok(!noInv.includes("--inventory") && !noInv.includes("--cmdline"));
  assert.match(noInv, / -i 'abc' -j$/);
});

test("playbook command for jsonl and text", () => {
  assert.match(playbookCommand({ repoPath: "/srv/example", playbook: "site.yml", inventory: "hosts", cmdline: ["--check"], envVars: {}, mode: "jsonl" }), /^cd '\/srv\/example' && exec env ANSIBLE_FORCE_COLOR='0' ANSIBLE_STDOUT_CALLBACK='ansible\.posix\.jsonl' ansible-playbook -i 'hosts' '--check' -- 'site\.yml'$/);
  const text = playbookCommand({ repoPath: "/srv/example", playbook: "site.yml", inventory: "hosts", cmdline: [], envVars: { X: "y z" }, mode: "text" });
  assert.match(text, /ANSIBLE_FORCE_COLOR='0'/);
  assert.match(text, /X='y z' ansible-playbook -i 'hosts' -- 'site\.yml'$/);
  assert.ok(!text.includes("ANSIBLE_STDOUT_CALLBACK"));
  assert.match(playbookCommand({ repoPath: "/srv/example", playbook: "site.yml", cmdline: [], envVars: {}, mode: "text" }), /ansible-playbook -- 'site\.yml'$/);
});

test("caller env cannot clobber the output callback or colour setting", () => {
  const c = playbookCommand({ repoPath: "/srv/example", playbook: "site.yml", cmdline: [], envVars: { ANSIBLE_STDOUT_CALLBACK: "yaml", ANSIBLE_FORCE_COLOR: "1", Z: "1" }, mode: "jsonl" });
  assert.match(c, /^cd '\/srv\/example' && exec env ANSIBLE_FORCE_COLOR='0' ANSIBLE_STDOUT_CALLBACK='ansible\.posix\.jsonl' Z='1' ansible-playbook -- 'site\.yml'$/);
  const t = playbookCommand({ repoPath: "/srv/example", playbook: "site.yml", cmdline: [], envVars: { ANSIBLE_FORCE_COLOR: "1" }, mode: "text" });
  assert.match(t, /exec env ANSIBLE_FORCE_COLOR='0' ansible-playbook/);
});

test("hostile env keys never reach the shell", () => {
  for (const key of ["X; touch /tmp/pwned; Y", "A=B", "1X", "$(id)", "", "a-b"]) {
    assert.throws(() => runnerCommand({ repoPath: "/srv/example", ident: "abc", playbook: "site.yml", cmdline: [], envVars: { [key]: "1" } }), /env_key/, key);
    assert.throws(() => playbookCommand({ repoPath: "/srv/example", playbook: "site.yml", cmdline: [], envVars: { [key]: "1" }, mode: "text" }), /env_key/, key);
  }
  assert.match(runnerCommand({ repoPath: "/srv/example", ident: "abc", playbook: "site.yml", cmdline: [], envVars: { _ok_1: "v" } }), /exec env _ok_1='v' ansible-runner/);
});

test("find command excludes roles and run artifacts and is bounded", () => {
  const c = findPlaybooksCommand("/srv/example");
  assert.ok(c.startsWith("cd '/srv/example' && find ."));
  assert.ok(c.includes("-path '*/roles/*'") && c.includes("-prune") && c.includes(".bb-runs") && c.includes("| head -n 500"));
});

test("hash listing shares the find filter, quotes the repo, hashes with sha256sum, and is bounded", () => {
  const c = hashPlaybooksCommand("/srv/ex ample");
  assert.ok(c.startsWith("cd '/srv/ex ample' && "));
  assert.ok(c.includes("-path '*/roles/*'") && c.includes(".bb-runs") && c.includes("group_vars") && c.includes("-prune"));
  assert.ok(c.includes("-printf '%p\\t%s\\n'") && c.includes("sha256sum <") && c.includes("| head -n 500 |"));
  assert.ok(c.includes(`IFS="$t" read -r p s`), "tab-separated so paths with spaces survive");
});

test("inventory discovery prints a type letter per entry and is bounded", () => {
  const c = discoverInventoriesCommand("/srv/example/inventories");
  assert.ok(c.startsWith("cd '/srv/example/inventories'"));
  assert.ok(c.includes("find -L ."), "follow symlinked inventories");
  assert.ok(c.includes("-maxdepth 2") && c.includes("group_vars") && c.includes("host_vars") && c.includes("%y") && c.includes("| head -n 200"));
});

test("probe, read, inventory list, status, and tail commands quote their paths", () => {
  assert.match(probeCommand("/srv/ex ample"), /git -C '\/srv\/ex ample' rev-parse --short HEAD/);
  assert.equal(probeCommand("/srv/example").split("echo '---'").length, 4);
  assert.ok(probeCommand("/srv/example").includes("command -v python3"));
  assert.ok(probeCommand("/srv/example").endsWith("; exit 0"), "a repo without git must not fail the probe");
  assert.equal(readFileCommand("/srv/example", "a b/site.yml"), "cd '/srv/example' && wc -c < 'a b/site.yml' && cat 'a b/site.yml'");
  assert.equal(inventoryListCommand("/srv/example", "inv/hosts"), "cd '/srv/example' && ansible-inventory -i 'inv/hosts' --list");
  const s = runStatusCommand("/srv/example", "r1", 4242);
  assert.ok(s.includes("'/srv/example/.bb-runs/r1/artifacts/r1'") && s.includes('"$d/status"') && s.includes('"$d/rc"') && s.includes("stream.log"));
  assert.ok(s.includes("p=4242") && s.includes('kill -0 "$p"') && s.includes("alive") && s.includes("dead"));
  const noPid = runStatusCommand("/srv/example", "r1");
  assert.ok(noPid.includes(`p=$(cat '/srv/example/.bb-runs/r1/pid' 2>/dev/null)`), "falls back to the supervisor's pid file");
  assert.equal(tailLogCommand("/srv/example", "r1", 0), "tail -c 1 '/srv/example/.bb-runs/r1/stream.log' 2>/dev/null");
  assert.equal(tailStreamCommand("/srv/example", "r1", 7), "tail -n +7 -F '/srv/example/.bb-runs/r1/stream.log'");
});

test("kill command uses INT by default and TERM on force", () => {
  assert.equal(killCommand(4242, "INT"), "kill -INT 4242");
  assert.equal(killCommand(4242, "TERM"), "kill -TERM 4242");
});

test("supervisor runs the inner command under python and points at the artifacts dir", () => {
  const c = supervisorCommand({ runDir: "/srv/example/.bb-runs/r1", ident: "r1", inner: "cd '/srv/example' && exec env A='1' true" });
  assert.ok(c.startsWith("exec python3 -c '"));
  assert.ok(c.endsWith(" '/srv/example/.bb-runs/r1' 'r1' 'cd '\\''/srv/example'\\'' && exec env A='\\''1'\\'' true'"));
  assert.ok(c.includes("SIGINT") && c.includes("preexec_fn"));
  assert.ok(c.indexOf("signal.signal(signal.SIGINT,fwd)") < c.indexOf("subprocess.Popen"), "handlers installed before the child exists");
  assert.ok(c.includes("os.getpid()") && c.includes("'pid'"), "writes its pid beside stream.log");
});

test("detached launch backgrounds only the wrapper and echoes its pid", () => {
  const c = detachedLaunchCommand("/srv/example/.bb-runs/r1", "exec python3 -c x", "/srv/example");
  assert.equal(c, "mkdir -p '/srv/example/.bb-runs/r1' && cd '/srv/example' && { setsid nohup bash -c 'exec python3 -c x' > '/srv/example/.bb-runs/r1/stream.log' 2>&1 < /dev/null & echo $!; }");
});
