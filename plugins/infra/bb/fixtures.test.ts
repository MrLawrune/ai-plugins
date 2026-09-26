import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Fixtures are synthetic. They may only use documentation address ranges (RFC 5737 / RFC 3849).
const PRIVATE = [
  /\b10\.\d+\.\d+\.\d+\b/, /\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/, /\b192\.168\.\d+\.\d+\b/,
  /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/, /\bfd[0-9a-f]{2}:/i,
  /smbios|vmgenid|uuid=/i,
];

test("fixtures contain no private addresses or machine identifiers", () => {
  const dir = new URL("./fixtures/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const text = readFileSync(new URL(f, dir), "utf8");
    for (const re of PRIVATE) assert.doesNotMatch(text, re, `${f} matches ${re}`);
  }
});
