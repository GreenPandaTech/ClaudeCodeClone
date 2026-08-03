import fs from "fs";
import path from "path";
import type { Message } from "./agent.js";

// Local, project-scoped session persistence. A session is the conversation
// transcript so far, saved to .mentor/sessions/<name>.json so it can be resumed
// later. Everything stays on disk in the user's own working directory — nothing
// is uploaded. Sessions can contain code/output the tools saw, so the .mentor
// directory is made self-ignoring to keep transcripts out of git by accident.
// The `.mentor` name predates the rename to TerminalAgent and is kept on purpose
// so existing stores keep resolving — see the NAMING note in config.ts.

export const SESSION_SCHEMA_VERSION = 1;

export interface SessionData {
  version: number;
  name: string;
  model: string;
  messages: Message[];
}

// Session names must be a single safe path segment — no separators or traversal.
const VALID_NAME = /^[A-Za-z0-9._-]+$/;

function assertValidName(name: string): void {
  if (!VALID_NAME.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid session name: ${JSON.stringify(name)} (use letters, digits, . _ -)`);
  }
}

export function serializeSession(name: string, model: string, messages: Message[]): string {
  const data: SessionData = { version: SESSION_SCHEMA_VERSION, name, model, messages };
  return JSON.stringify(data, null, 2);
}

export function parseSession(text: string): SessionData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid session file: not valid JSON (${String(err)})`, { cause: err });
  }
  if (raw === null || typeof raw !== "object") {
    throw new Error("Invalid session file: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== SESSION_SCHEMA_VERSION) {
    throw new Error(`Unsupported session version: ${String(obj.version)} (expected ${SESSION_SCHEMA_VERSION})`);
  }
  if (!Array.isArray(obj.messages)) {
    throw new Error("Invalid session file: messages must be an array");
  }
  return {
    version: SESSION_SCHEMA_VERSION,
    name: typeof obj.name === "string" ? obj.name : "",
    model: typeof obj.model === "string" ? obj.model : "",
    messages: obj.messages as Message[],
  };
}

function sessionsDir(cwd: string): string {
  return path.join(cwd, ".mentor", "sessions");
}

export function sessionPath(cwd: string, name: string): string {
  assertValidName(name);
  return path.join(sessionsDir(cwd), `${name}.json`);
}

/** Ensure .mentor exists and self-ignores, so transcripts never land in git. */
function ensureSessionStore(cwd: string): void {
  const dir = sessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(cwd, ".mentor", ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "*\n", "utf-8");
  }
}

export function saveSession(cwd: string, name: string, model: string, messages: Message[]): string {
  assertValidName(name);
  ensureSessionStore(cwd);
  const file = sessionPath(cwd, name);
  fs.writeFileSync(file, serializeSession(name, model, messages), "utf-8");
  return file;
}

export function loadSession(cwd: string, name: string): SessionData {
  assertValidName(name);
  const file = sessionPath(cwd, name);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Session not found: ${name}`, { cause: err });
  }
  return parseSession(text);
}

export function listSessions(cwd: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir(cwd));
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith(".json"))
    .map((e) => e.slice(0, -".json".length))
    .sort();
}
