// `bb infra …` — read-only context for agents. The only writes are thread scope pins.
import { cliCommand, defineCli, PluginCliError } from "@get-bb/plugin-sdk";
import type { Pins } from "./pins.ts";
import type { InfraService } from "./service.ts";
import { age } from "../shared/format.ts";

export interface CliDeps {
  service: InfraService;
  pins: Pins;
  threadExists(threadId: string): Promise<boolean>;
  setThreadMetadata(threadId: string, value: { targets: string[]; rules: boolean } | null): Promise<void>;
}

const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
const ok = (stdout: string) => ({ exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : stdout + "\n" });
const asJson = (v: unknown) => ok(JSON.stringify(v, null, 2));
const notFound = (target: string) => new PluginCliError(`unknown target ${target}`, { code: "not_found", hint: "run `bb infra envs`; targets look like <env>, <env>/<node>, or <env>/<node>/<vmid>" });

export function createCli(d: CliDeps) {
  const s = d.service;
  return defineCli({
    name: "infra",
    summary: "Read-only context about infrastructure environments (Proxmox hosts, VMs, LXCs)",
    description: "Targets: <env>, <env>/<node>, <env>/<node>/<vmid>. This command never changes infrastructure; operate through your usual tools.",
    commands: {
      envs: cliCommand({
        summary: "One line per environment: kind, hosts up, guests running, health",
        options: { json },
        run: ({ options }) => (options.json ? asJson(s.overview()) : ok(s.envIndex())),
      }),
      context: cliCommand({
        summary: "A compact card for an environment, host, or guest",
        positionals: [{ name: "target", description: "<env>, <env>/<node>, or <env>/<node>/<vmid>", required: true }],
        options: {
          rules: { type: "boolean", description: "Append the environment's rules" },
          budget: { type: "integer", min: 10, max: 400, default: 60, description: "Maximum output lines (10-400)" },
          json,
        },
        run: async ({ positionals, options }) => {
          const card = await s.card(positionals.target, { budget: options.budget, rules: options.rules });
          if (card === null) throw notFound(positionals.target);
          return options.json ? asJson({ target: positionals.target, card }) : ok(card);
        },
      }),
      registry: cliCommand({
        summary: "Full markdown registry of one environment",
        positionals: [{ name: "env", description: "Environment slug", required: true }],
        options: { json },
        run: ({ positionals, options }) => {
          const md = s.registry(positionals.env);
          if (md === null) throw notFound(positionals.env);
          return options.json ? asJson({ env: positionals.env, markdown: md }) : ok(md);
        },
      }),
      rules: cliCommand({
        summary: "The environment's rules (conventions agents must follow there)",
        positionals: [{ name: "env", description: "Environment slug", required: true }],
        options: { json },
        run: async ({ positionals, options }) => {
          const rules = await s.rules(positionals.env);
          if (rules === null) throw notFound(positionals.env);
          return options.json ? asJson({ env: positionals.env, rules }) : ok(rules.trim() || "(no rules)");
        },
      }),
      activity: cliCommand({
        summary: "Recent agent commands against a target and everything under it",
        positionals: [{ name: "target", description: "<env>, <env>/<node>, or <env>/<node>/<vmid>", required: true }],
        options: {
          since: { type: "duration", defaultUnit: "h", default: 3_600_000, min: 60_000, max: 14 * 86_400_000, description: "How far back (e.g. 30m, 6h, 2d; max 14d)" },
          limit: { type: "integer", min: 1, max: 200, default: 20, description: "Maximum rows (1-200)" },
          json,
        },
        run: ({ positionals, options }) => {
          if (!s.resolve(positionals.target)) throw notFound(positionals.target);
          const rows = s.activityText(positionals.target, options.since, options.limit);
          if (options.json) return asJson({ items: rows });
          const now = Date.now();
          return ok(rows.length ? rows.map((a) => `${age(now - a.at)} ago ${a.threadId} ${a.target} $ ${a.command}`).join("\n") : "(no agent activity)");
        },
      }),
      attach: cliCommand({
        summary: "Pin infra context to a thread: each of its turns receives these cards",
        positionals: [
          { name: "threadId", description: "Thread to pin (e.g. a subagent you dispatched)", required: true },
          { name: "targets", description: "One or more targets", required: true, variadic: true },
        ],
        options: { rules: { type: "boolean", description: "Include the environments' rules" }, json },
        run: async ({ positionals, options }) => {
          const resolved = positionals.targets.map((t) => s.resolve(t));
          const bad = positionals.targets.find((_, i) => !resolved[i]);
          if (bad) throw notFound(bad);
          if (!(await d.threadExists(positionals.threadId))) throw new PluginCliError(`unknown thread ${positionals.threadId}`, { code: "not_found" });
          const targets = [...new Set(resolved.map((r) => r!.target))];
          d.pins.set(positionals.threadId, targets, options.rules);
          await d.setThreadMetadata(positionals.threadId, { targets, rules: options.rules });
          return options.json ? asJson({ threadId: positionals.threadId, targets, rules: options.rules }) : ok(`pinned ${targets.join(", ")} to ${positionals.threadId}`);
        },
      }),
      detach: cliCommand({
        summary: "Remove a thread's infra pin",
        positionals: [{ name: "threadId", description: "Thread to unpin", required: true }],
        options: { json },
        run: async ({ positionals, options }) => {
          d.pins.clear(positionals.threadId);
          await d.setThreadMetadata(positionals.threadId, null);
          return options.json ? asJson({ threadId: positionals.threadId, detached: true }) : ok(`detached ${positionals.threadId}`);
        },
      }),
    },
  });
}
