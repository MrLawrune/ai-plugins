# playbooks

A BB plugin for building, running, and watching Ansible playbooks with your agents, on your own control host. Agents write the YAML; the plugin shows it in plain language and runs it. It never edits a playbook itself.

    bb plugin install git:https://github.com/MrLawrune/ai-plugins.git@^0.1.0 --plugin playbooks --tag-prefix playbooks/

## Requirements

On the **control host** (any machine you can SSH into):

- `ansible-core`, `ansible-runner`, and `python3`
- a git checkout of your playbook repository
- key-based SSH from the BB machine (agent, config alias, or key file; no passwords)

Nothing private is stored: the plugin keeps environment settings and run history only, never SSH secrets.

## Setup

Until an environment exists, BB lists the plugin as **needs configuration**.

1. Open **Settings → Plugins → Playbooks → Environments** and **Add environment**:
   - **Name**, **Slug** (used in targets like `lab/site.yml`), **Kind** (`lab`, `dev`, `staging`, `prod`, `customer`, `other`), **Color**
   - **Machine**: the BB machine that opens the SSH connection
   - **Control host**: SSH alias or host name as used in your SSH config
   - **Repository path** on the control host; optional **Inventory folder**
   - **Rules for agents**, **Agent approval**, **Run in check mode by default**
2. **Test connection** reports `ansible`, `ansible-runner`, the repository HEAD, and the playbook count.

Runs started by agents always need your confirmation in a form; outside lab and dev that is not optional, and production applies also require typing the playbook name.

- **Inventory folder** must be inside the repository (or empty for the repository itself). Discovered inventories are listed and run as repository-relative paths, e.g. `inventories/staging.yml`.
- **Deleting an environment** is refused while it has running runs; finished runs stay in the history.
- Add `.bb-runs/` to the repository's `.gitignore` on the control host: every run keeps its stream and artifacts there.

## Surfaces

| Where | What |
|---|---|
| Chat | `::playbook{env="lab" file="site.yml"}` card (plain-language plays and steps, live with the file); `::playbook-run{id="run_…"}` run card |
| Thread side panel → **Playbooks** | List view (plays, steps, details, raw YAML) and graph view (plays → roles → tasks, handler edges, live status during runs) |
| Composer | Run form: inventory, limit, tags, variables, check or apply |
| Run view | Per-host, per-task matrix, failures with messages, recap |
| Any node | **Add to chat**, **New thread**, and **Investigate** (read-only debug thread for a failed host) |
| Thread header | Chip with this thread's playbook runs |
| Command palette | "Playbooks: show this thread's playbooks" |

## CLI

| Command | Use |
|---|---|
| `bb playbooks envs` · `rules <env>` | Environments and their conventions |
| `bb playbooks library <env>` · `inventories <env> [--resolve p]` · `creds <env>` | What exists |
| `bb playbooks show <env>/<file>` · `check <env>/<file>` | Plain-language summary; syntax check and task list |
| `bb playbooks context <target> [--run id]` | Compact context for an environment, playbook, node, or run cell |
| `bb playbooks run <env>/<file> [--inventory i] [--limit l] [--tags t] [-e k=v] [--check\|--apply] [--wait] [--no-confirm]` | Start a run; check runs always include `--diff` |
| `bb playbooks status <runId>` · `log <runId> [--failed]` · `cancel <runId>` · `runs` | Follow runs |
| `bb playbooks investigate <runId> [--host h] [--node id]` | Read-only debug thread for a failure |

All commands accept `--json`. See [skills/playbooks/SKILL.md](skills/playbooks/SKILL.md).

`--no-confirm` only matters outside a thread (schedules, shells): it runs headless where policy allows. Inside a thread the confirmation form is still shown; the flag does not bypass it.

## Development

    npm install
    npm test          # node --test
    npm run typecheck
    bb plugin build

Design: [docs/superpowers/specs/2026-09-26-ansible-playbooks-design.md](../../docs/superpowers/specs/2026-09-26-ansible-playbooks-design.md).
