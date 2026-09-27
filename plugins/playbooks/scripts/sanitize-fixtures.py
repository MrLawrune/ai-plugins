#!/usr/bin/env python3
"""Turn raw ansible captures into lab-free fixtures under bb/fixtures.

Reads runner.jsonl, posix.jsonl, text.log, and inventory.json from the
capture directory (default /tmp/playbooks-fx) and writes runner_events.jsonl,
posix_jsonl.jsonl, text_log.txt, and inventory_list.json.

Sanitization rules:
  * every ``ansible_facts`` object is replaced by a small synthetic one
  * hostnames outside the allowed set become web-01 / web-02 / db-01
    (by order of appearance); real names are discovered from the facts
    and may be added with --host
  * IPv4 addresses become 192.0.2.N, IPv6 becomes 2001:db8::N, MAC
    addresses become 02:00:00:00:00:NN (and the MAC-derived uuid prefix
    ansible uses for play/task ids is rewritten to match)
  * the repo root (--repo, default: the longest /srv/<name> prefix seen)
    becomes /srv/example, /root and /home/<user> become /home/deploy
  * user names in well-known keys become deploy
  * runner ident, pid, and machine id are replaced by fixed values

Run from anywhere: ``python3 scripts/sanitize-fixtures.py [--src DIR] [--repo PATH] [--host NAME]...``
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ALLOWED_HOSTS = ["web-01", "web-02", "db-01"]
FIXTURE_DIR = Path(__file__).resolve().parent.parent / "bb" / "fixtures"
USER_KEYS = ("ansible_user_id", "ansible_user", "USER", "LOGNAME", "SUDO_USER", "user", "owner", "group", "ansible_user_gid")

IPV4 = re.compile(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b")
IPV6 = re.compile(r"\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b", re.I)
MAC = re.compile(r"\b([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b", re.I)


def safe_ipv4(o: tuple[str, str, str, str]) -> bool:
    a, b, c, _ = o
    if a in ("127", "0", "255"):
        return True
    if a == "192" and b == "0" and c == "2":
        return True
    return a == "255" or (a == "224") or all(x in ("0", "255") for x in o[:3])


class Mapper:
    def __init__(self, repo: str | None, hosts: list[str]):
        self.repo = repo
        self.hosts = hosts
        self.host_map: dict[str, str] = {}
        self.ipv4: dict[str, str] = {}
        self.ipv6: dict[str, str] = {}
        self.mac: dict[str, str] = {}

    def host_for(self, real: str) -> str:
        if real not in self.host_map:
            self.host_map[real] = ALLOWED_HOSTS[len(self.host_map) % len(ALLOWED_HOSTS)]
        return self.host_map[real]

    def ipv4_for(self, real: str) -> str:
        if real not in self.ipv4:
            self.ipv4[real] = f"192.0.2.{10 + len(self.ipv4)}"
        return self.ipv4[real]

    def ipv6_for(self, real: str) -> str:
        if real not in self.ipv6:
            self.ipv6[real] = f"2001:db8::{len(self.ipv6) + 1}"
        return self.ipv6[real]

    def mac_for(self, real: str) -> str:
        real = real.lower()
        if real not in self.mac:
            self.mac[real] = f"02:00:00:00:00:{len(self.mac) + 1:02x}"
        return self.mac[real]

    def text(self, s: str) -> str:
        # MACs first (they are also matched by the IPv6 pattern), then the
        # uuid prefix ansible derives from the MAC (aa:bb:cc:dd:ee:ff ->
        # aabbccdd-eeff-...).
        for m in set(MAC.findall(s)) | set(self.mac):
            fake = self.mac_for(m)
            s = re.sub(re.escape(m), fake, s, flags=re.I)
            real_pfx = m.lower().replace(":", "")
            fake_pfx = fake.replace(":", "")
            s = s.replace(f"{real_pfx[:8]}-{real_pfx[8:]}", f"{fake_pfx[:8]}-{fake_pfx[8:]}")
        s = IPV6.sub(lambda m: m.group(0) if m.group(0).startswith("2001:db8") or re.fullmatch(r"\d{1,2}:\d{2}:\d{2}", m.group(0)) else self.ipv6_for(m.group(0)), s)
        s = IPV4.sub(lambda m: m.group(0) if safe_ipv4(m.groups()) else self.ipv4_for(m.group(0)), s)
        if self.repo:
            s = s.replace(self.repo, "/srv/example")
        s = re.sub(r"/srv/(?!example\b)[A-Za-z0-9_.-]+", "/srv/example", s)
        s = re.sub(r"/home/(?!deploy\b)[A-Za-z0-9_.-]+", "/home/deploy", s)
        s = re.sub(r"(?<![A-Za-z0-9_])/root(?=[/\"' ]|$)", "/home/deploy", s)
        s = s.replace("spike/", "")
        for h in self.hosts:
            s = re.sub(rf"(?<![A-Za-z0-9._-]){re.escape(h)}(?![A-Za-z0-9._-])", self.host_for(h), s)
        s = re.sub(r'"(' + "|".join(USER_KEYS) + r')": "(?!deploy")[^"]*"', r'"\1": "deploy"', s)
        return s


def synthetic_facts(host: str, ip: str) -> dict:
    return {
        "ansible_all_ipv4_addresses": [ip],
        "ansible_all_ipv6_addresses": [],
        "ansible_architecture": "x86_64",
        "ansible_default_ipv4": {"address": ip, "alias": "eth0", "interface": "eth0", "netmask": "255.255.255.0", "network": "192.0.2.0", "prefix": "24", "type": "ether"},
        "ansible_distribution": "Debian",
        "ansible_distribution_major_version": "13",
        "ansible_distribution_version": "13",
        "ansible_fqdn": f"{host}.example.com",
        "ansible_hostname": host,
        "ansible_machine_id": "0" * 32,
        "ansible_nodename": host,
        "ansible_os_family": "Debian",
        "ansible_python_version": "3.13.0",
        "ansible_system": "Linux",
        "ansible_user_dir": "/home/deploy",
        "ansible_user_id": "deploy",
        "discovered_interpreter_python": "/usr/bin/python3",
    }


def discover(obj, found: dict) -> None:
    """Collect real hostnames, the MAC, and the user from any ansible_facts seen."""
    if isinstance(obj, dict):
        if "ansible_hostname" in obj:
            for k in ("ansible_hostname", "ansible_fqdn", "ansible_nodename"):
                v = obj.get(k)
                if isinstance(v, str) and v and v not in ALLOWED_HOSTS:
                    found.setdefault("hosts", []).append(v)
        for k, v in obj.items():
            if k == "macaddress" and isinstance(v, str) and MAC.fullmatch(v):
                found.setdefault("macs", []).append(v)
            discover(v, found)
    elif isinstance(obj, list):
        for v in obj:
            discover(v, found)


def strip_facts(obj, host: str, mapper: Mapper):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "ansible_facts" and isinstance(v, dict) and "ansible_hostname" in v:
                out[k] = synthetic_facts(host, mapper.ipv4_for(f"host:{host}"))
            elif k in ("ansible_env", "ansible_ssh_host_key_ed25519_public", "ansible_ssh_host_key_rsa_public", "ansible_ssh_host_key_ecdsa_public"):
                continue
            else:
                out[k] = strip_facts(v, host, mapper)
        return out
    if isinstance(obj, list):
        return [strip_facts(v, host, mapper) for v in obj]
    return obj


def sanitize_runner(lines: list[str], mapper: Mapper) -> list[str]:
    out = []
    for raw in lines:
        if not raw.strip():
            continue
        try:
            ev = json.loads(raw)
        except json.JSONDecodeError:
            out.append(mapper.text(raw))  # ansible-runner -j interleaves raw warning lines
            continue
        host = ev.get("event_data", {}).get("host") or "web-01"
        ev = strip_facts(ev, host, mapper)
        if "runner_ident" in ev:
            ev["runner_ident"] = "run-0001"
        if "pid" in ev:
            ev["pid"] = 4242
        out.append(mapper.text(json.dumps(ev)))
    return out


def sanitize_posix(lines: list[str], mapper: Mapper) -> list[str]:
    out = []
    for raw in lines:
        if not raw.strip():
            continue
        ev = json.loads(raw)
        hosts = ev.get("hosts")
        if isinstance(hosts, dict):
            ev["hosts"] = {h: strip_facts(v, h, mapper) for h, v in hosts.items()}
        out.append(mapper.text(json.dumps(ev)))
    return out


def sanitize_inventory(text: str, mapper: Mapper) -> str:
    inv = json.loads(text)
    hostvars = inv.setdefault("_meta", {}).setdefault("hostvars", {})
    for h in list(hostvars):
        hostvars[h] = {"ansible_host": mapper.ipv4_for(f"host:{h}"), "ansible_user": "deploy"}
    return mapper.text(json.dumps(inv, indent=2, sort_keys=True)) + "\n"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default="/tmp/playbooks-fx", type=Path)
    ap.add_argument("--out", default=FIXTURE_DIR, type=Path)
    ap.add_argument("--repo", help="absolute repo root on the control host, rewritten to /srv/example")
    ap.add_argument("--host", action="append", default=[], help="extra real hostname to rewrite")
    args = ap.parse_args(argv)

    runner = (args.src / "runner.jsonl").read_text().splitlines()
    posix = (args.src / "posix.jsonl").read_text().splitlines()
    text = (args.src / "text.log").read_text()
    inventory = (args.src / "inventory.json").read_text()

    found: dict = {}
    for raw in runner + posix:
        try:
            discover(json.loads(raw), found)
        except json.JSONDecodeError:
            pass
    hosts = [h for h in dict.fromkeys(args.host + found.get("hosts", [])) if h]
    hosts.sort(key=len, reverse=True)
    repo = args.repo
    if not repo:
        cands = re.findall(r"/srv/[A-Za-z0-9_.-]+", "\n".join(runner))
        repo = max(set(cands), key=cands.count) if cands else None
    mapper = Mapper(repo, hosts)
    for mac in dict.fromkeys(found.get("macs", [])):
        mapper.mac_for(mac)  # register before facts are stripped so uuid prefixes rewrite too

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "runner_events.jsonl").write_text("\n".join(sanitize_runner(runner, mapper)) + "\n")
    (args.out / "posix_jsonl.jsonl").write_text("\n".join(sanitize_posix(posix, mapper)) + "\n")
    (args.out / "text_log.txt").write_text(mapper.text(text))
    (args.out / "inventory_list.json").write_text(sanitize_inventory(inventory, mapper))
    print(f"hosts={mapper.host_map} ipv4={len(mapper.ipv4)} ipv6={len(mapper.ipv6)} mac={len(mapper.mac)} repo={repo}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
