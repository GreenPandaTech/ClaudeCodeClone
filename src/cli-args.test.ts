import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./cli-args.js";

test("no args yields interactive defaults", () => {
  const a = parseArgs([]);
  assert.equal(a.print, undefined);
  assert.equal(a.yes, false);
  assert.equal(a.help, false);
  assert.equal(a.version, false);
  assert.deepEqual(a.errors, []);
});

test("-p and --print capture the prompt", () => {
  assert.equal(parseArgs(["-p", "hello world"]).print, "hello world");
  assert.equal(parseArgs(["--print", "x"]).print, "x");
});

test("-p without a value is an error", () => {
  const a = parseArgs(["-p"]);
  assert.ok(a.errors.some((e) => /print/i.test(e)));
});

test("--model captures a value and errors without one", () => {
  assert.equal(parseArgs(["--model", "claude-x"]).model, "claude-x");
  assert.ok(parseArgs(["--model"]).errors.some((e) => /model/i.test(e)));
});

test("--yes sets auto-approve", () => {
  assert.equal(parseArgs(["--yes", "-p", "q"]).yes, true);
});

test("--resume captures a session name", () => {
  assert.equal(parseArgs(["--resume", "session-1"]).resume, "session-1");
});

test("--help and -h set help", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("--version and -v set version", () => {
  assert.equal(parseArgs(["--version"]).version, true);
  assert.equal(parseArgs(["-v"]).version, true);
});

test("an unknown flag is reported as an error", () => {
  assert.ok(parseArgs(["--bogus"]).errors.some((e) => /bogus|unknown/i.test(e)));
});

test("flags combine correctly", () => {
  const a = parseArgs(["--model", "m", "--yes", "-p", "do the thing"]);
  assert.equal(a.model, "m");
  assert.equal(a.yes, true);
  assert.equal(a.print, "do the thing");
  assert.deepEqual(a.errors, []);
});
