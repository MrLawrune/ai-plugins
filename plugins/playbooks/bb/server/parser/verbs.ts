const short = (action: string) => action.split(".").at(-1)!;
const arg = (args: { key: string; value: string }[], ...keys: string[]) => { for (const k of keys) { const a = args.find((x) => x.key === k); if (a) return a.value; } return null; };
const names = (v: string | null): string => { if (v === null) return ""; try { const j = JSON.parse(v) as unknown; return Array.isArray(j) ? j.map(String).join(", ") : String(j); } catch { return v; } };
const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + "…" : s);

export function plainLine(action: string, args: { key: string; value: string }[], name: string | null, notify: string[]): string {
  const base = name ?? verb(short(action), args);
  return notify.length ? `${base} → ${notify.join(", ")} when changed` : base;
}

function verb(m: string, args: { key: string; value: string }[]): string {
  const state = arg(args, "state"); const name = names(arg(args, "name", "pkg"));
  switch (m) {
    case "apt": case "dnf": case "yum": case "package": case "pip": case "apk": case "pacman":
      return `${state === "absent" ? "Remove" : "Install"} packages: ${name}`;
    case "service": case "systemd": case "systemd_service": {
      const n = arg(args, "name") ?? "service";
      if (state === "restarted") return `Restart ${n}`; if (state === "reloaded") return `Reload ${n}`; if (state === "stopped") return `Stop ${n}`;
      return arg(args, "enabled") === "true" ? `Enable and start ${n}` : `Start ${n}`;
    }
    case "template": case "copy": return `Write ${arg(args, "dest") ?? "file"}`;
    case "file": { const p = arg(args, "path", "dest", "name") ?? "path"; return state === "directory" ? `Create directory ${p}` : state === "absent" ? `Remove ${p}` : state === "link" ? `Link ${p}` : `Ensure ${p}`; }
    case "lineinfile": case "blockinfile": case "replace": return `Edit ${arg(args, "path", "dest") ?? "file"}`;
    case "user": return `${state === "absent" ? "Remove" : "Create"} user ${arg(args, "name") ?? ""}`.trim();
    case "group": return `${state === "absent" ? "Remove" : "Create"} group ${arg(args, "name") ?? ""}`.trim();
    case "git": return `Check out ${arg(args, "repo") ?? "repository"}`;
    case "command": case "shell": case "raw": case "script": return `Run: ${clip(arg(args, "_raw", "cmd") ?? "command")}`;
    case "debug": return `Print ${clip(arg(args, "msg", "var") ?? "")}`.trim();
    case "ufw": case "firewalld": return `Open port ${arg(args, "port", "rule") ?? ""}`.trim();
    case "uri": case "get_url": return `Fetch ${clip(arg(args, "url") ?? "")}`.trim();
    case "unarchive": return `Extract ${arg(args, "src") ?? "archive"}`;
    case "cron": return `Schedule ${arg(args, "name") ?? "job"}`;
    case "wait_for": return `Wait for ${arg(args, "port", "path", "host") ?? ""}`.trim();
    case "include_tasks": case "import_tasks": return `Include ${arg(args, "file", "_raw") ?? "tasks"}`;
    case "include_role": case "import_role": return `Apply role ${arg(args, "name") ?? ""}`.trim();
    case "block": return "Group of steps";
    default: return `${m} ${clip(args[0]?.value ?? "", 40)}`.trim();
  }
}
