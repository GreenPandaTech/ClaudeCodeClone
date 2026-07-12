import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { readForPreview } from "./preview.js";
import { isSensitivePath } from "./tools.js";

test("readForPreview returns file contents for an ordinary file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mentor-prev-"));
  const file = path.join(dir, "notes.txt");
  fs.writeFileSync(file, "hello\nworld");
  assert.equal(readForPreview(file), "hello\nworld");
});

test("readForPreview never reads a sensitive path (no secret disclosure in the diff)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mentor-prev-"));
  const secret = path.join(dir, ".env.production");
  fs.writeFileSync(secret, "DB_PASSWORD=hunter2\nAPI_KEY=sk-secret");
  assert.equal(isSensitivePath(secret), true);
  assert.equal(readForPreview(secret), ""); // suppressed — its contents are never returned
});

test("readForPreview returns empty for a nonexistent file (new-file write)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mentor-prev-"));
  assert.equal(readForPreview(path.join(dir, "does-not-exist.ts")), "");
});
