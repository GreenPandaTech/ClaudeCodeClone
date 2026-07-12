import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, formatDiff, diffStat } from "./diff.js";

test("identical text produces only context lines", () => {
  const lines = diffLines("a\nb\nc", "a\nb\nc");
  assert.deepEqual(lines.map((l) => l.tag), [" ", " ", " "]);
});

test("a changed line is a removal followed by an addition", () => {
  const lines = diffLines("a\nb\nc", "a\nB\nc");
  const tags = lines.map((l) => l.tag).join("");
  // b removed, B added, a and c unchanged
  assert.ok(tags.includes("-"));
  assert.ok(tags.includes("+"));
  const removed = lines.filter((l) => l.tag === "-").map((l) => l.text);
  const added = lines.filter((l) => l.tag === "+").map((l) => l.text);
  assert.deepEqual(removed, ["b"]);
  assert.deepEqual(added, ["B"]);
});

test("pure insertion adds only new lines and keeps the rest as context", () => {
  const lines = diffLines("a\nc", "a\nb\nc");
  assert.deepEqual(lines.filter((l) => l.tag === "+").map((l) => l.text), ["b"]);
  assert.equal(lines.filter((l) => l.tag === "-").length, 0);
});

test("pure deletion removes only the dropped lines", () => {
  const lines = diffLines("a\nb\nc", "a\nc");
  assert.deepEqual(lines.filter((l) => l.tag === "-").map((l) => l.text), ["b"]);
  assert.equal(lines.filter((l) => l.tag === "+").length, 0);
});

test("a new file (empty old) is all additions", () => {
  const lines = diffLines("", "x\ny");
  assert.deepEqual(lines.map((l) => l.tag), ["+", "+"]);
});

test("diffStat counts additions and removals", () => {
  const stat = diffStat("a\nb\nc", "a\nB\nc\nd");
  assert.equal(stat.removed, 1); // b
  assert.equal(stat.added, 2); // B, d
});

test("formatDiff renders +/- prefixes deterministically", () => {
  const out = formatDiff("a\nb", "a\nB");
  assert.ok(out.includes("-b"));
  assert.ok(out.includes("+B"));
  // deterministic
  assert.equal(out, formatDiff("a\nb", "a\nB"));
});

test("formatDiff folds long unchanged runs with context", () => {
  const big = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
  const changed = big.replace("line25", "CHANGED25");
  const out = formatDiff(big, changed, { context: 2 });
  // should not print all 50 unchanged lines
  assert.ok(out.split("\n").length < 30);
  assert.ok(out.includes("CHANGED25"));
  assert.ok(/unchanged/i.test(out));
});

test("very large inputs still return promptly via prefix/suffix trimming", () => {
  const a = Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n");
  const b = a.replace("l2500", "l2500-edited");
  const start = Date.now();
  const stat = diffStat(a, b);
  assert.ok(Date.now() - start < 1000);
  assert.equal(stat.added, 1);
  assert.equal(stat.removed, 1);
});
