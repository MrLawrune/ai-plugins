---
name: playbooks
description: Build and run Ansible playbooks with the Playbooks plugin — environments with a control host, plain-language cards, live runs, and `bb playbooks`. Use when creating, editing, or running playbooks, or when a run failed.
---

# Playbooks

Each **environment** has a control host, a git repository of playbooks, an inventory root, and rules. You write playbooks **over SSH on the control host** with your usual tools; the plugin reads, shows, and runs them. It never edits files.

## Targets
`<env>` · `<env>/<path>` · `<env>/<path>#<node>` (nodes: `p0` play, `p0/t1` task, `p0/rname` role, `p0/h0` handler) · runs `run_…`

## Commands
| Command | Use |
|---|---|
| `bb playbooks envs` | Environments, control hosts, status |
| `bb playbooks rules <env>` | Conventions you must follow there |
| `bb playbooks context <target> [--run id]` | Compact context block for an env, playbook, play, task, or run cell |
| `bb playbooks show <env>/<file>` | Plain-language summary; ends with the `::playbook` line to paste |
| `bb playbooks check <env>/<file>` | Parse warnings + syntax check + task list on the control host |
| `bb playbooks library <env>` · `inventories <env> [--resolve p]` · `creds <env>` | What exists |
| `bb playbooks run <env>/<file> [--inventory i] [--limit l] [--tags t] [-e k=v] [--check\|--apply] [--wait]` | Start a run; the human confirms in a form |
| `bb playbooks status <runId>` · `log <runId> [--failed]` · `cancel <runId>` · `runs` | Follow runs |
| `bb playbooks investigate <runId> [--host h] [--node id]` | Open a read-only debug thread for a failure |
All commands accept `--json`.

## Workflow
1. `bb playbooks envs`, then `bb playbooks rules <env>` before touching a repository.
2. Edit on the control host (`ssh <controlHost>`; repo path from `envs`). Commit as usual.
3. After every create or edit: `bb playbooks show <env>/<file>` and put its last line, alone on a line, in your reply: `::playbook{env="lab" file="site.yml"}`.
4. Run with `bb playbooks run … --wait`. Check mode is the default. The human sees a form and may change inventory, limit, or mode.
5. After a run, put `::playbook-run{id="run_…"}` on its own line. For failures, read `bb playbooks log <runId> --failed`, fix, rerun.
