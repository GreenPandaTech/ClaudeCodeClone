import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  safeRegExp,
  includeToRegExp,
  isSensitivePath,
  configureExtraDenylist,
  readFile,
  writeFile,
  editFile,
} from "./tools.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccc-test-"));
}

// ─── safeRegExp ───────────────────────────────────────────────────────────────

test("safeRegExp compiles a safe pattern", () => {
  const re = safeRegExp("foo\\d+");
  assert.ok(re instanceof RegExp);
  assert.ok(re!.test("foo123"));
  assert.ok(!re!.test("bar"));
});

test("safeRegExp rejects overly long patterns", () => {
  assert.equal(safeRegExp("a".repeat(501)), null);
});

test("safeRegExp rejects catastrophic-backtracking patterns", () => {
  assert.equal(safeRegExp("(.*)*"), null);
  assert.equal(safeRegExp("(.+)+"), null);
});

test("safeRegExp returns null for an invalid regex", () => {
  assert.equal(safeRegExp("("), null);
});

// ─── includeToRegExp ──────────────────────────────────────────────────────────

test("includeToRegExp returns null when no include is given", () => {
  assert.equal(includeToRegExp(undefined), null);
});

test("includeToRegExp translates a simple glob", () => {
  const re = includeToRegExp("*.ts")!;
  assert.ok(re.test("index.ts"));
  assert.ok(!re.test("index.js"));
});

test("includeToRegExp handles brace alternation", () => {
  const re = includeToRegExp("*.{ts,tsx}")!;
  assert.ok(re.test("app.ts"));
  assert.ok(re.test("app.tsx"));
  assert.ok(!re.test("app.js"));
});

// ─── isSensitivePath ──────────────────────────────────────────────────────────

test("isSensitivePath flags denylisted names, extensions and prefixes", () => {
  assert.equal(isSensitivePath(path.resolve(os.tmpdir(), ".env")), true);
  assert.equal(isSensitivePath(path.resolve(os.tmpdir(), "secret.pem")), true);
  assert.equal(isSensitivePath(path.resolve(os.tmpdir(), "server.key")), true);
  assert.equal(isSensitivePath(path.join(os.homedir(), ".ssh", "id_ed25519")), true);
});

test("isSensitivePath allows an ordinary file", () => {
  assert.equal(isSensitivePath(path.resolve(os.tmpdir(), "notes.txt")), false);
});

test("configureExtraDenylist extends the denied filenames", () => {
  const target = path.resolve(os.tmpdir(), "company-secrets.json");
  assert.equal(isSensitivePath(target), false);
  configureExtraDenylist(["company-secrets.json"]);
  try {
    assert.equal(isSensitivePath(target), true);
    // case-insensitive, like the built-in denylist
    assert.equal(isSensitivePath(path.resolve(os.tmpdir(), "COMPANY-SECRETS.JSON")), true);
  } finally {
    configureExtraDenylist([]); // reset so other tests are unaffected
  }
});

// ─── readFile offset/limit numbering ──────────────────────────────────────────

test("readFile numbers lines using offset and limit", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "sample.txt");
    fs.writeFileSync(file, "l1\nl2\nl3\nl4\nl5\n", "utf-8");
    const res = readFile(file, 2, 2);
    assert.equal(res.isError, undefined);
    const lines = res.output.split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "   2\tl2");
    assert.equal(lines[1], "   3\tl3");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── editFile error paths ─────────────────────────────────────────────────────

test("editFile reports when old_string is not found", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "edit.txt");
    fs.writeFileSync(file, "hello world", "utf-8");
    const res = editFile(file, "goodbye", "hi");
    assert.equal(res.isError, true);
    assert.match(res.output, /not found/);
    assert.equal(fs.readFileSync(file, "utf-8"), "hello world");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("editFile refuses a non-unique old_string", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "edit.txt");
    fs.writeFileSync(file, "foo foo", "utf-8");
    const res = editFile(file, "foo", "bar");
    assert.equal(res.isError, true);
    assert.match(res.output, /appears 2 times/);
    assert.equal(fs.readFileSync(file, "utf-8"), "foo foo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── write/edit security gap ──────────────────────────────────────────────────

test("writeFile refuses to write to a sensitive path", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "secret.pem");
    const res = writeFile(file, "-----BEGIN PRIVATE KEY-----");
    assert.equal(res.isError, true);
    assert.match(res.output, /not permitted/);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("editFile refuses to edit a sensitive path", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "SECRET=1", "utf-8");
    const res = editFile(file, "SECRET=1", "SECRET=2");
    assert.equal(res.isError, true);
    assert.match(res.output, /not permitted/);
    assert.equal(fs.readFileSync(file, "utf-8"), "SECRET=1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
