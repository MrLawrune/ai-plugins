---
name: infra
description: Read-only context about the user's infrastructure environments (Proxmox hosts, VMs, LXCs) — inventory, IPs, state, per-environment rules, recent agent activity — via `bb infra`. Use before working on lab/staging/prod machines, and when dispatching subagents that will.
---

# Infra context

The Infra plugin watches the user's Proxmox environments and shows the human what agents do there. It gives you **context only, never access**: operate hosts and guests with your usual tools (ssh, bash). If you can't reach a host that way, the plugin won't change that.

Nothing is injected into your turns by default. Pull what you need.

## Targets

`<env>` · `<env>/<node>` · `<env>/<node>/<vmid>` — e.g. `homelab`, `homelab/pve1`, `homelab/pve1/201`. Node names are case-insensitive.

## Commands

| Command | Use |
|---|---|
| `bb infra envs` | One line per environment: kind, hosts up, guests running, health |
| `bb infra context <target> [--rules] [--budget N]` | Compact card (default ≤ 60 lines). `--rules` appends the environment's rules |
| `bb infra registry <env>` | Full markdown inventory of one environment |
| `bb infra rules <env>` | The environment's rules — follow them when working there |
| `bb infra activity <target> [--since 6h]` | What agents recently ran against it |
| `bb infra attach <threadId> <target>… [--rules]` | Pin cards into another thread's every turn |
| `bb infra detach <threadId>` | Remove the pin |

All commands accept `--json`.

## Before you touch a machine

1. `bb infra context <target> --rules` — confirm it exists, its state, IPs, and the rules (e.g. "Podman, not Docker", "prefer LXCs", "new CTs go in pool X").
2. In a `prod` environment, confirm with the user before any change.

## Dispatching subagents (orchestrators)

Give each subagent only the context it needs:

- **Short task:** run `bb infra context <target> --rules` and paste the card into the subagent's prompt.
- **Long-running subagent:** after spawning it, `bb infra attach <its threadId> <target> --rules` so every turn carries a fresh card; `bb infra detach` when done.

Don't paste whole registries unless the task needs the inventory.

## Showing the human

After you create or change a guest, put a live card on its own line in your reply:

```
::infra-guest{env="homelab" id="pve1/245"}
::infra-host{env="homelab" node="pve1"}
```

The card shows current state and opens the Infra side panel when clicked.
