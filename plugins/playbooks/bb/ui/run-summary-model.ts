// Pure text for a run summary: the recap counts once there is a recap, a readable progress line only while it runs.
import type { RunSummaryDto } from "../schemas.ts";
import { statusLabel } from "../shared/format.ts";

const LIVE = new Set<RunSummaryDto["status"]>(["running", "starting"]);
const MAX_LINE = 80;

/** The runner's last line for a live run; JSON objects (raw runner events) are never shown. */
export function progressLine(lastLine: string | null): string | null {
  const line = lastLine?.trim() ?? "";
  if (!line || line.startsWith("{")) return null;
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** "failed · check · 3 hosts · 1 failed · 2 changed", or the live progress line while running. */
export function runDetail(r: RunSummaryDto, withEnv: boolean): string {
  const parts = [statusLabel(r.status).toLowerCase()];
  if (r.check) parts.push("check");
  if (r.hosts !== null) parts.push(`${r.hosts} host${r.hosts === 1 ? "" : "s"}`, `${r.failedHosts ?? 0} failed`, `${r.changedHosts ?? 0} changed`);
  else if (LIVE.has(r.status)) {
    const line = progressLine(r.lastLine);
    if (line) parts.push(line);
  }
  return (withEnv ? [r.env.name, ...parts] : parts).join(" · ");
}

export const runRowText = (r: RunSummaryDto): string => runDetail(r, true);
