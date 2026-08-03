// Reproduces the /undo transcript in the README by driving the REAL built
// binary (dist/index.js) through a scripted session:
//
//   1. the user asks for a change; the (replayed) model calls edit_file
//   2. the user approves; the edit applies and is checkpointed
//   3. /changes shows the diff
//   4. the user hand-edits greet.js OUTSIDE TerminalAgent
//   5. /undo refuses with a diff instead of clobbering the hand edit
//
// The model side is examples/replay-server.mjs on 127.0.0.1 (the SDK honours
// ANTHROPIC_BASE_URL), so this needs no API key and nothing leaves the
// machine. Everything else — SDK, agentic loop, approval gate, tools,
// checkpoints, slash commands — is the real production code path.
//
//   npm run build && node examples/capture-transcript.mjs

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { startReplayServer } from "./replay-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.join(here, "demo-project");
const greetFile = path.join(demoDir, "greet.js");

const ORIGINAL = "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n";
const HAND_EDIT = "export function greet(name) {\n  return `Hey from TerminalAgent, ${name}!`;\n}\n";

// Fresh fixture and checkpoint store, so the transcript is identical every run.
fs.rmSync(path.join(demoDir, ".mentor"), { recursive: true, force: true });
fs.writeFileSync(greetFile, ORIGINAL, "utf-8");

const { port, close } = await startReplayServer();

const child = spawn(
  process.execPath,
  ["--enable-source-maps", path.join(here, "repl-tty-shim.mjs")],
  {
    cwd: demoDir,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "unused-local-replay",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\r/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/** Wait until output appended after `mark` ends with `suffix` (REPL idle). */
function waitForTail(suffix, mark, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (stripAnsi(out.slice(mark)).endsWith(suffix)) return resolve(undefined);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for ${JSON.stringify(suffix)}; got:\n${out}`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Type a line, then wait for the output that follows it to end with suffix. */
function typeAndWait(line, suffix) {
  const mark = out.length;
  child.stdin.write(line + "\n");
  return waitForTail(suffix, mark);
}

try {
  await waitForTail("> ", 0);
  await typeAndWait("change greet() to greet from TerminalAgent instead of a plain hello", "[y/N] ");
  await typeAndWait("y", "> ");
  await typeAndWait("/changes", "> ");
  // The user hand-edits the file OUTSIDE TerminalAgent between /changes and /undo.
  fs.writeFileSync(greetFile, HAND_EDIT, "utf-8");
  await typeAndWait("/undo", "> ");
  child.stdin.write("/exit\n");
  await new Promise((resolve) => child.on("close", resolve));
} finally {
  close();
  child.kill();
  // Leave the fixture and the checkpoint store the way the next run expects.
  fs.writeFileSync(greetFile, ORIGINAL, "utf-8");
  fs.rmSync(path.join(demoDir, ".mentor"), { recursive: true, force: true });
}

// Strip ANSI escapes and normalise line endings; cut before the /exit cost
// footer (session bookkeeping, not part of the story).
const transcript = stripAnsi(out).split("\n> /exit")[0];

console.log(transcript);
