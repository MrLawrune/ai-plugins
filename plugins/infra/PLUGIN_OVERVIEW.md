See your infrastructure and what your agents are doing to it, without leaving BB.

## What you get

- An **Infra** page: every environment (homelab, staging, a customer's prod) with health, hosts, and guests; drill into any host, LXC, or VM for resources, IPs, config, storage, snapshots, backups, Proxmox tasks, and CPU / memory / network / disk charts.
- **Agent activity**: every command an agent runs against a host or guest (ssh, pct, qm, pvesh), linked to its thread, plus which thread most likely created, removed, or stopped a guest.
- **In threads**: an Infra side panel that lists what the thread touched, a header chip, a running marker on sidebar rows, and live `::infra-guest` cards agents can drop into chat.
- **Ask agent**: start a thread about any environment, host, or guest with its live summary and your rules already in the prompt.
- **Context for agents, on request**: `bb infra` prints compact cards, registries, and your per-environment rules; orchestrators can pin a card to a subagent's thread. Nothing is injected by default.

## How it works

The plugin polls each Proxmox VE API endpoint you add (read-only GET requests; a `PVEAuditor` token is enough) and keeps the snapshot on the BB server. Credentials are stored as BB secrets and never reach the browser or agents. Certificates are pinned on first use.
