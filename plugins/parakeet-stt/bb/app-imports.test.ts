// An install from a git tag builds the frontend without dev dependencies, so
// nothing app.tsx pulls in at runtime may import the SDK except its app entry
// (testing helpers and the server entry are dev-only too).
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

const SDK = "@get-bb/plugin-sdk";
const ALLOWED_SDK = "@get-bb/plugin-sdk/app";

/** An SDK specifier a runtime install cannot resolve: anything under the package except its app entry. */
function isForbiddenSdkImport(spec: string): boolean {
  return spec.startsWith(SDK) && spec !== ALLOWED_SDK;
}

function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(BB, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  const bare = base.replace(/\.js$/, "");
  return [base, `${bare}.ts`, `${bare}.tsx`].find((f) => existsSync(f) && /\.tsx?$/.test(f)) ?? null;
}

test("the frontend imports only the SDK app entry at runtime", () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [path.join(BB, "app.tsx")];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of valueImports(file)) {
      if (isForbiddenSdkImport(spec)) offenders.push(`${path.relative(BB, file)} -> ${spec}`);
      const next = resolve(file, spec);
      if (next) queue.push(next);
    }
  }
  assert.ok(seen.has(path.join(BB, "schemas.ts")), "the walk reaches the shared schemas");
  assert.ok(seen.has(path.join(BB, "ui", "target.ts")), "the walk reaches the split-out composer code");
  assert.deepEqual(offenders, []);
});

test("the SDK guard flags every specifier but the app entry", () => {
  assert.equal(isForbiddenSdkImport("@get-bb/plugin-sdk"), true);
  assert.equal(isForbiddenSdkImport("@get-bb/plugin-sdk/testing/app"), true);
  assert.equal(isForbiddenSdkImport("@get-bb/plugin-sdk/provider-bridge"), true);
  assert.equal(isForbiddenSdkImport("@get-bb/plugin-sdk/app"), false);
  assert.equal(isForbiddenSdkImport("react"), false);
});
