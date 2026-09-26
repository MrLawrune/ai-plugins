import { test } from "node:test";
import assert from "node:assert/strict";
import { envRow, guest, host, snapshotOf } from "../test-util.ts";
import { buildIndex, matchCommand } from "./matcher.ts";
import { parseSshConfig } from "./ssh-config.ts";

const sshConfig = `
# personal hosts
Host pve1
  HostName 192.0.2.10
Host stage1
  HostName=198.51.100.5
Host proxy
  HostName 192.0.2.201
  User root
Host *.example.com
  User x
`;

const snaps = [
  snapshotOf(envRow("homelab"), [host("pve1", { ip: "192.0.2.10" })], [guest("pve1", 101, { name: "homeauto", type: "qemu" }), guest("pve1", 201, { name: "proxy" })]),
  snapshotOf(envRow("staging", "staging"), [host("stage1", { ip: "198.51.100.5" })], [guest("stage1", 201, { name: "web" })]),
];
const index = buildIndex(snaps, parseSshConfig(sshConfig), new Map([["homelab/pve1/201", ["192.0.2.201"]], ["staging/stage1/201", ["198.51.100.20"]]]));

const cases: [string, string[]][] = [
  ["ssh pve1 'pct exec 201 -- podman ps'", ["homelab/pve1", "homelab/pve1/201"]],
  ["ssh root@192.0.2.10 qm start 101", ["homelab/pve1", "homelab/pve1/101"]],
  ["ssh -p 22 -i ~/.ssh/id pve1 uptime", ["homelab/pve1"]],
  ["curl -k https://192.0.2.10:8006/api2/json/version", ["homelab/pve1"]],
  ["curl -k https://192.0.2.101:8006/", []],
  ["ping -c1 192.0.2.1", []],
  ["pct exec 201 -- ls", []],
  ["ssh proxy systemctl reload proxy", ["homelab/pve1/201"]],
  ["ssh root@proxy uptime", ["homelab/pve1/201"]],
  ["cat proxy.conf", []],
  ["echo proxy", []],
  ["ssh 192.0.2.201 uptime", ["homelab/pve1/201"]],
  ["pvesh get /nodes/pve1/lxc/201/config", ["homelab/pve1", "homelab/pve1/201"]],
  ["ssh stage1 pct list", ["staging/stage1"]],
  ["ssh stage1 'pct exec 201 -- ls'", ["staging/stage1", "staging/stage1/201"]],
  ["ssh pve1 'pct exec 999 -- ls'", ["homelab/pve1"]],
  ["scp file pve1:/tmp/", ["homelab/pve1"]],
  ["rsync -a dir/ root@198.51.100.20:/srv/", ["staging/stage1/201"]],
  ["ssh pve1 true && ssh stage1 'pct exec 201 -- ls'", ["homelab/pve1", "staging/stage1"]],
  ["ls -la && cat CLAUDE.md", []],
  ["cat > t.ts <<'EOF'\nconst c = \"ssh pve1 'pct exec 201 -- podman ps'\";\nEOF\nnode t.ts", []],
  ["cat <<EOF | ssh pve1 bash\npct exec 201 -- ls\nEOF", ["homelab/pve1"]],
  ["python3 - <<'PY'\nprint('ssh stage1')\nPY\nssh pve1 uptime", ["homelab/pve1"]],
  // Names and IPs count only where they are a destination, never as search text or prose.
  ["git grep -nIE \"pve1|192.0.2.10\" -- .", []],
  ["grep -rlE 'PVE1|stage1' . | wc -l", []],
  ["git commit -m \"ssh pve1 fix\"", []],
  ["echo 192.0.2.10 >> hosts.txt", []],
  ["cat notes/pve1.md", []],
  ["ping -c1 192.0.2.10", ["homelab/pve1"]],
  ["nc -zv pve1 8006", ["homelab/pve1"]],
  ["ssh-keyscan 192.0.2.10 >> known_hosts", ["homelab/pve1"]],
  ["curl -sk https://pve1:8006/api2/json/version | jq .", ["homelab/pve1"]],
  ["curl -s --resolve x.example:443:192.0.2.201 https://x.example/", ["homelab/pve1/201"]],
  ["grep -c pve1 log.txt; curl -s http://198.51.100.20/", ["staging/stage1/201"]],
  ["bash -c \"ssh pve1 uptime\"", ["homelab/pve1"]],
  ["for h in pve1 stage1; do ssh -o BatchMode=yes $h uptime; done", ["homelab/pve1", "staging/stage1"]],
  ["for h in pve1; do echo \"== $h\"; ssh \"$h\" 'pct exec 201 -- ls'; done", ["homelab/pve1", "homelab/pve1/201"]],
  ["H=stage1; ssh ${H} pct list", ["staging/stage1"]],
  ["for f in pve1 stage1; do grep -c $f log; done", []],
];

for (const [command, expected] of cases) {
  test(`matches: ${command}`, () => {
    assert.deepEqual(matchCommand(command, index), expected);
  });
}

test("ssh config: aliases, '=' syntax, multiple names, wildcards and Match blocks skipped", () => {
  const m = parseSshConfig(`Host a b\n  HostName 10.1.1.1\nHost c\nHost *\n  User z\nMatch host d\n  HostName 9.9.9.9\nHost e # trailing\n  hostname E.lan\n`);
  assert.deepEqual([...m].sort(), [["a", "10.1.1.1"], ["b", "10.1.1.1"], ["c", "c"], ["e", "e.lan"]]);
});
