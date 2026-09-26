// Optional human-facing export of an environment's registry and rules (e.g. into a notes vault).
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export async function writeExport(dir: string, slug: string, registry: string, rules: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, `${slug}-registry.md`), registry);
  await atomicWrite(join(dir, `${slug}-rules.md`), rules);
}
