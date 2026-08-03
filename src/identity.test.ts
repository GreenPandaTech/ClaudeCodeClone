import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Honesty tripwire: the running product must present as TerminalAgent, not Claude Code.
// index.ts is the impure shell (not importable in a test), so we scan its source.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexSrc = fs.readFileSync(path.join(root, "src", "index.ts"), "utf-8");

test("the REPL speaker label is TerminalAgent, not Claude", () => {
  assert.ok(indexSrc.includes("TerminalAgent: "), "expected a 'TerminalAgent: ' speaker label");
  assert.ok(!/["'`]\s*\\n?Claude:\s/.test(indexSrc), "found a leftover 'Claude:' speaker label");
});

test("the system prompt identifies as TerminalAgent", () => {
  assert.ok(/You are TerminalAgent/.test(indexSrc));
  assert.ok(!/You are Claude Code/.test(indexSrc));
});
