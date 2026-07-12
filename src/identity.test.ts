import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Honesty tripwire: the running product must present as Mentor, not Claude Code.
// index.ts is the impure shell (not importable in a test), so we scan its source.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexSrc = fs.readFileSync(path.join(root, "src", "index.ts"), "utf-8");

test("the REPL speaker label is Mentor, not Claude", () => {
  assert.ok(indexSrc.includes("Mentor: "), "expected a 'Mentor: ' speaker label");
  assert.ok(!/["'`]\s*\\n?Claude:\s/.test(indexSrc), "found a leftover 'Claude:' speaker label");
});

test("the system prompt identifies as Mentor", () => {
  assert.ok(/You are Mentor/.test(indexSrc));
  assert.ok(!/You are Claude Code/.test(indexSrc));
});
