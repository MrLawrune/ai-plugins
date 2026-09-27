// Local run-log housekeeping: the stream copies under the plugin data dir are pruned with the run rows.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Deletes files under `root` (one level of per-thread directories) last modified before `beforeMs`; returns how many. */
export async function pruneLogs(root: string, beforeMs: number): Promise<number> {
  let removed = 0;
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    for (const f of await readdir(dir).catch(() => [])) {
      const path = join(dir, f);
      const s = await stat(path).catch(() => null);
      if (s?.isFile() && s.mtimeMs < beforeMs) { await rm(path, { force: true }); removed++; }
    }
    if ((await readdir(dir).catch(() => ["x"])).length === 0) await rm(dir, { recursive: true, force: true });
  }
  return removed;
}
