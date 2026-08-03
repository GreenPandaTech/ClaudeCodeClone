import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  serializeSession,
  parseSession,
  saveSession,
  loadSession,
  listSessions,
  SESSION_SCHEMA_VERSION,
} from "./session.js";
import type { Message } from "./agent.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-sess-"));
}

const SAMPLE: Message[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: [{ type: "text", text: "hi there" }] },
];

// ─── serialize / parse ────────────────────────────────────────────────────────

test("serialize then parse round-trips a session", () => {
  const json = serializeSession("demo", "model-x", SAMPLE);
  const data = parseSession(json);
  assert.equal(data.version, SESSION_SCHEMA_VERSION);
  assert.equal(data.name, "demo");
  assert.equal(data.model, "model-x");
  assert.deepEqual(data.messages, SAMPLE);
});

test("serialized session is deterministic", () => {
  assert.equal(serializeSession("d", "m", SAMPLE), serializeSession("d", "m", SAMPLE));
});

test("parseSession fails loud on non-JSON", () => {
  assert.throws(() => parseSession("not json"), /session|json/i);
});

test("parseSession fails loud on a wrong schema version", () => {
  const json = JSON.stringify({ version: 999, name: "x", model: "m", messages: [] });
  assert.throws(() => parseSession(json), /version/i);
});

test("parseSession fails loud when messages is missing or not an array", () => {
  assert.throws(() => parseSession(JSON.stringify({ version: SESSION_SCHEMA_VERSION, name: "x", model: "m" })), /messages/i);
  assert.throws(
    () => parseSession(JSON.stringify({ version: SESSION_SCHEMA_VERSION, name: "x", model: "m", messages: "no" })),
    /messages/i,
  );
});

// ─── save / load / list ───────────────────────────────────────────────────────

test("saveSession then loadSession round-trips through disk", () => {
  const dir = tmpDir();
  saveSession(dir, "work", "model-y", SAMPLE);
  const data = loadSession(dir, "work");
  assert.deepEqual(data.messages, SAMPLE);
  assert.equal(data.model, "model-y");
});

test("saveSession writes a self-ignoring .mentor/.gitignore", () => {
  const dir = tmpDir();
  saveSession(dir, "work", "m", SAMPLE);
  const ignore = fs.readFileSync(path.join(dir, ".mentor", ".gitignore"), "utf-8");
  assert.match(ignore, /\*/);
});

test("listSessions returns saved names, sorted, empty when none", () => {
  const dir = tmpDir();
  assert.deepEqual(listSessions(dir), []);
  saveSession(dir, "beta", "m", SAMPLE);
  saveSession(dir, "alpha", "m", SAMPLE);
  assert.deepEqual(listSessions(dir), ["alpha", "beta"]);
});

test("loadSession fails loud for a missing session", () => {
  assert.throws(() => loadSession(tmpDir(), "nope"), /not found|no such|nope/i);
});

test("session names with path traversal are rejected", () => {
  const dir = tmpDir();
  assert.throws(() => saveSession(dir, "../evil", "m", SAMPLE), /name/i);
  assert.throws(() => loadSession(dir, "../../etc/passwd"), /name/i);
  assert.throws(() => saveSession(dir, "a/b", "m", SAMPLE), /name/i);
});
