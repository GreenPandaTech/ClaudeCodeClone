import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { parseConfigFile, loadConfig, loadProjectContext, DEFAULT_CONFIG } from "./config.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mentor-cfg-"));
}

// ─── parseConfigFile ──────────────────────────────────────────────────────────

test("parseConfigFile reads a full config", () => {
  const cfg = parseConfigFile('{"model":"m","maxTokens":100,"autoApprove":true,"extraDenylist":["a.json"]}');
  assert.deepEqual(cfg, { model: "m", maxTokens: 100, autoApprove: true, extraDenylist: ["a.json"] });
});

test("parseConfigFile accepts a partial config", () => {
  assert.deepEqual(parseConfigFile("{}"), {});
  assert.deepEqual(parseConfigFile('{"model":"x"}'), { model: "x" });
});

test("parseConfigFile fails loud on malformed JSON", () => {
  assert.throws(() => parseConfigFile("not json"), /config|json/i);
});

test("parseConfigFile fails loud on wrong types", () => {
  assert.throws(() => parseConfigFile('{"maxTokens":"abc"}'), /maxTokens/);
  assert.throws(() => parseConfigFile('{"extraDenylist":"x"}'), /extraDenylist/);
  assert.throws(() => parseConfigFile('{"autoApprove":"yes"}'), /autoApprove/);
});

// ─── loadConfig ───────────────────────────────────────────────────────────────

test("loadConfig returns defaults when no file and no env", () => {
  const cfg = loadConfig(tmpDir(), {});
  assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test("loadConfig reads a .mentorrc.json file", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".mentorrc.json"), '{"model":"file-model","maxTokens":123}');
  const cfg = loadConfig(dir, {});
  assert.equal(cfg.model, "file-model");
  assert.equal(cfg.maxTokens, 123);
  assert.equal(cfg.autoApprove, DEFAULT_CONFIG.autoApprove);
});

test("environment variables win over the config file", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".mentorrc.json"), '{"model":"file-model"}');
  const cfg = loadConfig(dir, { MODEL: "env-model", AUTO_APPROVE: "1", MAX_TOKENS: "999" });
  assert.equal(cfg.model, "env-model");
  assert.equal(cfg.autoApprove, true);
  assert.equal(cfg.maxTokens, 999);
});

test("loadConfig fails loud on an invalid MAX_TOKENS env", () => {
  assert.throws(() => loadConfig(tmpDir(), { MAX_TOKENS: "not-a-number" }), /MAX_TOKENS/);
});

test("loadConfig fails loud on a malformed config file", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".mentorrc.json"), "{ broken");
  assert.throws(() => loadConfig(dir, {}), /config|json/i);
});

// ─── loadProjectContext ───────────────────────────────────────────────────────

test("loadProjectContext returns null when no memory file exists", () => {
  assert.equal(loadProjectContext(tmpDir()), null);
});

test("loadProjectContext reads MENTOR.md", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "MENTOR.md"), "# House rules\nUse tabs.");
  const ctx = loadProjectContext(dir);
  assert.ok(ctx && ctx.includes("House rules"));
});

test("loadProjectContext falls back to AGENTS.md", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "agents content");
  assert.ok(loadProjectContext(dir)?.includes("agents content"));
});

test("MENTOR.md takes precedence over AGENTS.md", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "MENTOR.md"), "mentor wins");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "agents loses");
  assert.ok(loadProjectContext(dir)?.includes("mentor wins"));
});

test("loadProjectContext truncates an oversized file with a notice", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "MENTOR.md"), "x".repeat(50_000));
  const ctx = loadProjectContext(dir);
  assert.ok(ctx);
  assert.ok(ctx.length < 50_000);
  assert.match(ctx, /truncated/i);
});
