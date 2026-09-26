// Infra page routing: /plugins/infra/infra/<env>[/<node>[/<vmid>]].
import { parseTarget } from "../server/targets.ts";

export type Route =
  | { view: "overview" }
  | { view: "env"; slug: string }
  | { view: "host"; slug: string; node: string; target: string }
  | { view: "guest"; slug: string; node: string; vmid: number; target: string };

export function parseSubPath(subPath: string): Route {
  const t = parseTarget(subPath.replace(/^\/+|\/+$/g, ""));
  if (!t || !subPath.replace(/\//g, "")) return { view: "overview" };
  if (t.node === undefined) return { view: "env", slug: t.env };
  if (t.vmid === undefined) return { view: "host", slug: t.env, node: t.node, target: `${t.env}/${t.node}` };
  return { view: "guest", slug: t.env, node: t.node, vmid: t.vmid, target: `${t.env}/${t.node}/${t.vmid}` };
}

export const subPathFor = (target: string | null) => target ?? "";
