import fs from "fs";
import path from "path";

// Configuration for a Mentor session, resolved from (in increasing precedence)
// built-in defaults, a project-local .mentorrc.json, and environment variables.

export interface MentorConfig {
  model: string;
  maxTokens: number;
  autoApprove: boolean;
  /** Extra filenames (basename match) to add to the sensitive-path denylist. */
  extraDenylist: string[];
}

export const DEFAULT_MODEL = "claude-sonnet-4-6";

export const DEFAULT_CONFIG: MentorConfig = {
  model: DEFAULT_MODEL,
  maxTokens: 64_000,
  autoApprove: false,
  extraDenylist: [],
};

// Cap on project-context size injected into the system prompt.
const MAX_PROJECT_CONTEXT = 16_000;

/** Parse the raw text of a .mentorrc.json into a partial config, fail-loud. */
export function parseConfigFile(text: string): Partial<MentorConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid .mentorrc.json: not valid JSON (${String(err)})`, { cause: err });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid .mentorrc.json: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<MentorConfig> = {};

  if ("model" in obj) {
    if (typeof obj.model !== "string") throw new Error("Invalid config: model must be a string");
    out.model = obj.model;
  }
  if ("maxTokens" in obj) {
    if (typeof obj.maxTokens !== "number" || !Number.isFinite(obj.maxTokens) || obj.maxTokens <= 0) {
      throw new Error("Invalid config: maxTokens must be a positive number");
    }
    out.maxTokens = obj.maxTokens;
  }
  if ("autoApprove" in obj) {
    if (typeof obj.autoApprove !== "boolean") throw new Error("Invalid config: autoApprove must be a boolean");
    out.autoApprove = obj.autoApprove;
  }
  if ("extraDenylist" in obj) {
    if (!Array.isArray(obj.extraDenylist) || obj.extraDenylist.some((e) => typeof e !== "string")) {
      throw new Error("Invalid config: extraDenylist must be an array of strings");
    }
    out.extraDenylist = obj.extraDenylist as string[];
  }
  return out;
}

/** Resolve the effective config from a config file (if present) and env vars. */
export function loadConfig(cwd: string, env: Record<string, string | undefined>): MentorConfig {
  const cfg: MentorConfig = { ...DEFAULT_CONFIG };

  // Layer 1: the config file.
  const file = path.join(cwd, ".mentorrc.json");
  if (fs.existsSync(file)) {
    const parsed = parseConfigFile(fs.readFileSync(file, "utf-8"));
    Object.assign(cfg, parsed);
  }

  // Layer 2: environment variables (highest precedence).
  if (env.MODEL) cfg.model = env.MODEL;
  if (env.MAX_TOKENS != null && env.MAX_TOKENS !== "") {
    const n = Number(env.MAX_TOKENS);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid MAX_TOKENS environment variable: ${env.MAX_TOKENS}`);
    }
    cfg.maxTokens = n;
  }
  if (env.AUTO_APPROVE === "1") cfg.autoApprove = true;

  return cfg;
}

/** Load project memory (MENTOR.md, else AGENTS.md) from cwd, bounded in size. */
export function loadProjectContext(cwd: string): string | null {
  for (const name of ["MENTOR.md", "AGENTS.md"]) {
    const file = path.join(cwd, name);
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue; // not present / unreadable — try the next candidate
    }
    if (content.length > MAX_PROJECT_CONTEXT) {
      content =
        content.slice(0, MAX_PROJECT_CONTEXT) +
        `\n\n… (${name} truncated at ${MAX_PROJECT_CONTEXT} characters)`;
    }
    return content;
  }
  return null;
}
