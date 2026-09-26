import { test } from "node:test";
import assert from "node:assert/strict";
import { bytes } from "./format.ts";
import { configRows, networkRows, parseDisk, parseNet, parseProps, sizeLabel, contentLabels } from "./pve-config.ts";

test("property strings split into head and key/values", () => {
  assert.deepEqual(parseProps("local-lvm:vm-100-disk-0,size=8G,ssd"), { head: "local-lvm:vm-100-disk-0", props: { size: "8G", ssd: "1" } });
  assert.deepEqual(parseProps("name=eth0,bridge=vmbr0"), { head: null, props: { name: "eth0", bridge: "vmbr0" } });
});

test("disks: storage volumes, bind mounts, cdroms", () => {
  assert.deepEqual(parseDisk("rootfs", "local-lvm:vm-100-disk-0,size=8G"), { key: "rootfs", storage: "local-lvm", volume: "vm-100-disk-0", size: "8 GiB", mount: "/", media: null, options: [] });
  const bind = parseDisk("mp0", "/srv/data,mp=/data,backup=0");
  assert.equal(bind.storage, "bind mount");
  assert.equal(bind.volume, "/srv/data");
  assert.equal(bind.mount, "/data");
  assert.deepEqual(bind.options, ["no backup"]);
  const vm = parseDisk("scsi0", "tank:vm-101-disk-1,discard=on,iothread=1,size=32G,cache=writeback");
  assert.deepEqual([vm.storage, vm.size, vm.mount], ["tank", "32 GiB", null]);
  assert.deepEqual(vm.options, ["discard", "iothread", "cache=writeback"]);
  const cd = parseDisk("ide2", "none,media=cdrom");
  assert.deepEqual([cd.storage, cd.volume, cd.media], ["none", "", "cdrom"]);
});

test("nets: LXC and QEMU forms", () => {
  const ct = parseNet("net0", "name=eth0,bridge=vmbr0,firewall=1,gw=192.0.2.1,hwaddr=bc:24:11:00:00:01,ip=192.0.2.10/24,ip6=auto,tag=20,type=veth");
  assert.deepEqual([ct.name, ct.mac, ct.bridge, ct.vlan, ct.firewall, ct.ipv4, ct.ipv6, ct.gateway], ["eth0", "BC:24:11:00:00:01", "vmbr0", "20", true, "192.0.2.10/24", "auto", "192.0.2.1"]);
  const vm = parseNet("net1", "virtio=BC:24:11:00:00:02,bridge=vmbr1,queues=4");
  assert.deepEqual([vm.name, vm.model, vm.mac, vm.firewall, vm.options], ["net1", "virtio", "BC:24:11:00:00:02", false, ["queues=4"]]);
});

test("network rows join config NICs to live interfaces by MAC, then list runtime-only ones", () => {
  const rows = networkRows(
    { net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp", net1: "name=eth1,bridge=vmbr1,hwaddr=BC:24:11:00:00:09,ip=198.51.100.5/24" },
    [
      { name: "vpn0", mac: null, ipv4: ["198.51.100.77"], ipv6: ["2001:db8::7"] },
      { name: "eth0", mac: "bc:24:11:00:00:01", ipv4: ["192.0.2.10"], ipv6: ["fe80::1", "2001:db8::10"] },
    ],
  );
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0]!.name, rows[0]!.ipv4, rows[0]!.ipv6, rows[0]!.bridge, rows[0]!.live, rows[0]!.configured], ["eth0", ["192.0.2.10"], ["2001:db8::10"], "vmbr0", true, "dhcp"]);
  assert.deepEqual([rows[1]!.name, rows[1]!.ipv4, rows[1]!.live, rows[1]!.configured], ["eth1", [], false, "198.51.100.5/24"]);
  assert.deepEqual([rows[2]!.name, rows[2]!.bridge, rows[2]!.live], ["vpn0", null, true]);
});

test("config rows read as plain values", () => {
  const rows = configRows({ memory: "1024", swap: "512", onboot: "1", unprivileged: "0", features: "nesting=1,keyctl=0", nameserver: "192.0.2.1 192.0.2.2", agent: "1,fstrim_cloned_disks=1", ostype: "debian" }, bytes);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.memory!.value, bytes(1024 * 1024 * 1024));
  assert.equal(by.onboot!.value, "yes");
  assert.equal(by.unprivileged!.value, "no");
  assert.deepEqual(by.features!.chips, ["nesting"]);
  assert.deepEqual(by.nameserver!.chips, ["192.0.2.1", "192.0.2.2"]);
  assert.deepEqual(by.agent!.chips, ["enabled", "fstrim_cloned_disks"]);
  assert.equal(by.ostype!.value, "debian");
});

test("disk sizes use binary units", () => {
  assert.deepEqual(["16G", "512M", "1T", "4096", "weird"].map(sizeLabel), ["16 GiB", "512 MiB", "1 TiB", "4096 B", "weird"]);
});

test("storage content reads as friendly labels in a stable order", () => {
  assert.deepEqual(contentLabels(["backup", "rootdir", "custom", "images"]), ["VM disks", "CT volumes", "Backups", "custom"]);
});
