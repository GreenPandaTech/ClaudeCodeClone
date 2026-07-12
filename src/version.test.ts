import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { VERSION } from "./version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("VERSION is a semver string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("package.json version matches VERSION", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
  assert.equal(pkg.version, VERSION);
});

test("README references the current version", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf-8");
  assert.ok(readme.includes(`v${VERSION}`), `README should mention v${VERSION}`);
});
