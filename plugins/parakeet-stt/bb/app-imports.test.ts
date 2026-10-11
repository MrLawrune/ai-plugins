// An install from a git tag builds the frontend without dev dependencies, so
// nothing app.tsx pulls in at runtime may import the server SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const BB = import.meta.dirname;
const IMPORT = /^(import|export)\s+(type\s+)?(?:([^"';]*?)\s+from\s+)?["']([^"']+)["']/gm;

/** Whether the statement survives type erasure. */
function isValueImport(typeOnly: string | undefined, clause: string | undefined): boolean {
  if (typeOnly) return false;
  const named = clause?.match(/^\{([^}]*)\}$/s);
  if (!named) return true;
  return named[1].split(",").map((s) => s.trim()).filter(Boolean).some((s) => !s.startsWith("type "));
}

function valueImports(file: string): string[] {
  const out: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) if (isValueImport(m[2], m[3])) out.push(m[4]);
  return out;
}

function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(BB, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  const bare = base.replace(/\.js$/, "");
  return [base, `${bare}.ts`, `${bare}.tsx`].find((f) => existsSync(f) && /\.tsx?$/.test(f)) ?? null;
}

test("the frontend never imports the server SDK at runtime", () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [path.join(BB, "app.tsx")];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of valueImports(file)) {
      if (spec === "@get-bb/plugin-sdk") offenders.push(path.relative(BB, file));
      const next = resolve(file, spec);
      if (next) queue.push(next);
    }
  }
  assert.ok(seen.has(path.join(BB, "schemas.ts")), "the walk reaches the shared schemas");
  assert.deepEqual(offenders, []);
});
