# infra

A BB plugin for watching Proxmox infrastructure and the agents working on it. Read-only: it never changes your hosts.

    bb plugin install git:https://github.com/MrLawrune/ai-plugins.git@^0.1.0 --plugin infra --tag-prefix infra/

## Setup

Until an environment has a working connection, BB lists the plugin as **needs configuration** and says what is missing.

1. On each Proxmox host (or once per cluster), create a read-only token:

       pveum user add bb-view@pve --comment "BB Infra (read-only)"
       pveum aclmod / -user bb-view@pve -role PVEAuditor
       pveum user token add bb-view@pve infra --privsep 0

2. In BB open **Settings → Plugins → Infra → Environments**:
   - **Add environment**: name, kind (`lab`, `dev`, `staging`, `prod`, `customer`, `other`), optional rules for agents, optional conventions file.
   - **Add connection**: the API URL (`https://<host>:8006`), token ID `bb-view@pve!infra`, and the token secret. **Fetch certificate → Trust**, then **Save and test**.
   - Optional **Web UI link**: a browser-reachable URL for "Open in Proxmox" when the API URL is not reachable from every device (e.g. through a reverse proxy).

Username/password sign-in also works (tickets renew automatically). OIDC realms need a token. Secrets are stored as BB secrets and never reach the browser or agents.

### Environment options

| Option | Default | Notes |
|---|---|---|
| Poll interval | lab/dev 10 s · staging/other 30 s · prod/customer 60 s | Each poll is two small GETs per connection |
| Guest IP sweep | 5 min | One detail read per running guest; 0 turns it off (IPs then load when a guest is opened) |
| Rules for agents | — | Short conventions, e.g. "Podman, not Docker" |
| Conventions file | — | Absolute path on the BB server to an existing `AGENTS.md` or runbook; included with the rules (capped at 16 KiB) |
| Export folder | — | Writes `<slug>-registry.md` and `<slug>-rules.md` on change |

## Surfaces

| Where | What |
|---|---|
| Sidebar → **Infra** | Environments → hosts → guests, charts, tasks, backups; **Agent activity** tab |
| Thread side panel → **+ → Infra** | What this thread touched, then everything; one tab per target, each closable |
| Thread header | `⬢ N` chip of touched targets |
| Chat | `::infra-guest{env="homelab" id="pve1/201"}`, `::infra-host{env="homelab" node="pve1"}` |
| Composer | `@` → Infra: attach a live card to a message |
| New-thread screen | Health strip per environment |
| Command palette | "Infra: open environments", "Infra: show this thread's infrastructure" |

## CLI

`bb infra envs | context <target> | registry <env> | rules <env> | activity <target> | attach <threadId> <target>… | detach <threadId>` — see [skills/infra/SKILL.md](skills/infra/SKILL.md).

## Development

    npm install
    npm test          # node --test
    npm run typecheck
    bb plugin build

Design: [docs/superpowers/specs/2026-09-25-infra-design.md](../../docs/superpowers/specs/2026-09-25-infra-design.md).
