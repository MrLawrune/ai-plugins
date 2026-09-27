Build, run, and watch Ansible playbooks with your agents, on your own control host.

## What you get

- **Plain-language cards**: agents write playbooks; a `::playbook` card in chat shows the plays and steps in words and stays current with the file. Raw YAML is always one click further.
- **A side panel** with a list view and a graph view (plays, roles, tasks, handlers), with live per-task status during runs.
- **Run forms, not command lines**: pick inventory, limit, tags, variables, and check or apply mode, then confirm.
- **Live runs**: per-host progress, failures with the message, recap, and history.
- **Targeted dispatch**: from any play, task, or run cell, **Add to chat**, start a **New thread**, or **Investigate** a failed host in a read-only debug thread.
- **Context for agents, on request**: `bb playbooks` prints environments, rules, playbook summaries, and run logs.

## How it works

The plugin reads and runs on your control host over SSH, using `ansible-core` and `ansible-runner` there. It never edits playbooks; agents do that with their ordinary tools. Runs need your confirmation. Nothing private is stored: no SSH secrets, only environment settings and run history.
