#!/usr/bin/env node
import "dotenv/config";
import readline from "readline";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import path from "path";
import { TOOL_DEFINITIONS, executeTool, configureExtraDenylist } from "./tools.js";
import { formatDiff } from "./diff.js";
import { classifyCommand } from "./safety.js";
import { loadConfig, loadProjectContext, type MentorConfig } from "./config.js";
import { parseArgs } from "./cli-args.js";
import { saveSession, loadSession, listSessions } from "./session.js";
import { estimateCost, type ModelUsage } from "./pricing.js";
import { runAgenticLoop, runOnce, type AgentContext, type LlmClient, type LlmStream, type Message } from "./agent.js";
import { VERSION } from "./version.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Tools that modify the system require explicit confirmation before running,
// unless autoApprove is set (via config, AUTO_APPROVE=1, or --yes).
const DESTRUCTIVE_TOOLS = new Set(["bash", "write_file", "edit_file"]);

// ─── System prompt (cached — never changes, so stays at the front of the prefix) ──
// Mentor is honest about being Mentor (an assistant built on the Anthropic API),
// not the Claude Code product it is modelled on.

const SYSTEM_PROMPT_BASE = `You are Mentor, an expert AI coding assistant running in the user's terminal, built on the Anthropic API.

You have access to the following tools to help you work with their codebase:
- read_file: Read file contents with line numbers
- write_file: Create or overwrite files
- edit_file: Make exact string replacements in files (read first to get exact content)
- bash: Execute shell commands
- glob: Find files by pattern
- grep: Search file contents
- ask_user: Ask the user a clarifying question when needed

Working directory: ${process.cwd()}

Guidelines:
- Always read files before editing them to ensure you have the current content
- Use edit_file for small targeted changes, write_file for new files or full rewrites
- Ask the user before taking any destructive or irreversible actions
- Be concise in your explanations — show code, not walls of prose
- When exploring an unfamiliar codebase, start with glob/grep to understand the structure
- Prefer making atomic, focused changes over large sweeping rewrites`;

// ─── CLI args (parsed before anything that needs an API key) ──────────────────

const cliArgs = parseArgs(process.argv.slice(2));

if (cliArgs.help) {
  printCliHelp();
  process.exit(0);
}
if (cliArgs.version) {
  console.log(VERSION);
  process.exit(0);
}
if (cliArgs.errors.length > 0) {
  for (const e of cliArgs.errors) console.error(chalk.red(e));
  console.error(chalk.dim("Run with --help for usage."));
  process.exit(2);
}

// ─── Client ───────────────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    chalk.red("Error: ANTHROPIC_API_KEY is not set.\n") +
      chalk.dim("Create a .env file with ANTHROPIC_API_KEY=sk-ant-... or set the environment variable.")
  );
  process.exit(1);
}

const client = new Anthropic();

// ─── Resolved configuration and system prompt ─────────────────────────────────

function loadConfigOrExit(): MentorConfig {
  try {
    return loadConfig(process.cwd(), process.env);
  } catch (err) {
    console.error(chalk.red("Configuration error: " + (err instanceof Error ? err.message : String(err))));
    process.exit(1);
  }
}

const config = loadConfigOrExit();
configureExtraDenylist(config.extraDenylist);

// Fold project memory (MENTOR.md / AGENTS.md) into the cached system prompt.
const projectContext = loadProjectContext(process.cwd());
const SYSTEM_TEXT = projectContext
  ? `${SYSTEM_PROMPT_BASE}\n\n# Project context (from MENTOR.md / AGENTS.md)\n\n${projectContext}`
  : SYSTEM_PROMPT_BASE;

// Adapter over the real streaming API — the loop lives in agent.ts and is driven
// through this seam (a fake replaces it in the tests).
const llm: LlmClient = {
  // The SDK's event union is wider than the loop needs; cast at this one seam.
  stream: (params) => client.messages.stream(params) as unknown as LlmStream,
};

// ─── UI helpers ───────────────────────────────────────────────────────────────

function printBanner() {
  console.log(chalk.cyan.bold(`\n  Mentor v${VERSION}`));
  console.log(chalk.dim(`  Model: ${config.model}`));
  console.log(chalk.dim(`  CWD: ${process.cwd()}`));
  if (projectContext) console.log(chalk.dim("  Loaded project memory (MENTOR.md / AGENTS.md)"));
  if (config.autoApprove) console.log(chalk.yellow("  AUTO-APPROVE is ON — destructive actions run without confirmation"));
  console.log(chalk.dim("  Type /help for commands, Ctrl+C to exit\n"));
}

function printHelp() {
  console.log(chalk.bold("\nCommands:"));
  console.log(chalk.cyan("  /help         ") + "Show this help");
  console.log(chalk.cyan("  /clear        ") + "Clear conversation history");
  console.log(chalk.cyan("  /cost         ") + "Show token usage and estimated cost per model");
  console.log(chalk.cyan("  /cwd <path>   ") + "Change the working directory");
  console.log(chalk.cyan("  /model [id]   ") + "Show or switch the model for later turns");
  console.log(chalk.cyan("  /save [name]  ") + "Save this conversation to .mentor/sessions");
  console.log(chalk.cyan("  /resume [name]") + " Load a saved conversation");
  console.log(chalk.cyan("  /sessions     ") + "List saved sessions");
  console.log(chalk.cyan("  /exit         ") + "Exit the program\n");
}

function printToolCall(name: string, input: Record<string, unknown>) {
  const label = chalk.yellow(`[tool: ${name}]`);
  const preview = getToolPreview(name, input);
  process.stdout.write(`\n${label} ${chalk.dim(preview)}\n`);

  // Rich, colored diff preview before the user approves a file change.
  if (name === "edit_file") {
    printDiffPreview(String(input.old_string ?? ""), String(input.new_string ?? ""));
  } else if (name === "write_file") {
    let existing = "";
    try {
      existing = fs.readFileSync(path.resolve(String(input.file_path)), "utf-8");
    } catch {
      /* new file — diff against empty */
    }
    printDiffPreview(existing, String(input.content ?? ""));
  } else if (name === "bash") {
    const risk = classifyCommand(String(input.command ?? ""));
    if (risk.level !== "normal") {
      const paint = risk.level === "danger" ? chalk.red.bold : chalk.yellow;
      process.stdout.write("  " + paint(`⚠ ${risk.level.toUpperCase()}: ${risk.reason}`) + "\n");
    }
  }
}

// Print a colored, context-folded unified diff (green additions, red removals).
function printDiffPreview(oldText: string, newText: string) {
  const diff = formatDiff(oldText, newText, { context: 2 });
  if (!diff) return;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) process.stdout.write("  " + chalk.green(line) + "\n");
    else if (line.startsWith("-")) process.stdout.write("  " + chalk.red(line) + "\n");
    else process.stdout.write("  " + chalk.dim(line) + "\n");
  }
}

function getToolPreview(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return String(input.file_path);
    case "write_file":
      return String(input.file_path);
    case "edit_file":
      return String(input.file_path);
    case "bash": {
      // Show the full command — never truncate, so the user sees what they're approving.
      const cmd = String(input.command ?? "");
      const cwd = input.cwd ? `  cwd: ${input.cwd}` : "";
      return cmd + (cwd ? `\n${cwd}` : "");
    }
    case "glob":
      return String(input.pattern);
    case "grep":
      return `/${input.pattern}/${input.include ? ` in ${input.include}` : ""}`;
    case "ask_user":
      return String(input.prompt).slice(0, 60);
    default:
      return JSON.stringify(input).slice(0, 60);
  }
}

function printToolResult(result: { output: string; isError?: boolean }) {
  if (result.isError) {
    const lines = result.output.split("\n").slice(0, 5).join("\n");
    process.stdout.write(chalk.red(`  ✗ ${lines}\n`));
  } else {
    const lines = result.output.split("\n");
    const preview = lines.slice(0, 3).join("\n");
    const suffix = lines.length > 3 ? chalk.dim(`\n  … (${lines.length} lines)`) : "";
    process.stdout.write(chalk.dim(`  ✓ ${preview}${suffix}\n`));
  }
}

// ─── Token tracking (per model, so /cost is accurate across model switches) ────

const usageByModel: Record<string, ModelUsage> = {};

function trackUsage(model: string, usage: Anthropic.Usage) {
  const u = (usageByModel[model] ??= {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  u.inputTokens += usage.input_tokens;
  u.outputTokens += usage.output_tokens;
  u.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  u.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

function printCost() {
  const est = estimateCost(usageByModel);
  if (est.lines.length === 0) {
    console.log(chalk.dim("\nNo usage yet this session.\n"));
    return;
  }
  console.log(chalk.bold("\nSession usage:"));
  for (const line of est.lines) {
    const label = line.known ? line.model : `${line.model}${chalk.yellow(" (est.)")}`;
    console.log(`  ${label}`);
    console.log(
      chalk.dim(
        `    in ${line.usage.inputTokens.toLocaleString()}  out ${line.usage.outputTokens.toLocaleString()}` +
          `  cache-read ${line.usage.cacheReadTokens.toLocaleString()}  cache-write ${line.usage.cacheWriteTokens.toLocaleString()}`,
      ),
    );
    console.log(`    cost $${line.cost.toFixed(4)}`);
  }
  console.log(chalk.cyan(`  Total estimated cost: $${est.total.toFixed(4)}`));
  if (est.anyUnknown) {
    console.log(chalk.dim("  (est.) = model not in the price table; Sonnet-class rates assumed"));
  }
  console.log("");
}

// ─── Agent context factory ────────────────────────────────────────────────────
// Builds the dependency-injected context that drives the loop in agent.ts.

function buildAgentContext(
  confirm: (name: string, input: Record<string, unknown>) => Promise<boolean>
): AgentContext {
  return {
    client: llm,
    io: {
      onText: (text) => process.stdout.write(text),
      onToolCall: (name, input) => printToolCall(name, input),
      onToolResult: (result) => printToolResult(result),
      confirm,
    },
    execute: executeTool,
    tools: TOOL_DEFINITIONS as unknown as Anthropic.Tool[],
    model: config.model,
    maxTokens: config.maxTokens,
    system: [
      {
        type: "text",
        text: SYSTEM_TEXT,
        // Cache the system prompt — it never changes between turns
        cache_control: { type: "ephemeral" },
      },
    ],
    autoApprove: config.autoApprove,
    destructiveTools: DESTRUCTIVE_TOOLS,
    onUsage: (usage) => trackUsage(config.model, usage),
    retry: {
      maxRetries: 3,
      baseDelayMs: 500,
      onRetry: (attempt, delayMs, err) => {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          chalk.yellow(`\n  ⟳ transient API error (${reason}); retry ${attempt} in ${delayMs}ms…\n`),
        );
      },
    },
  };
}

// ─── Main REPL ────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  const messages: Message[] = [];

  // Seed from a saved session when --resume <name> was passed.
  if (cliArgs.resume) {
    try {
      const data = loadSession(process.cwd(), cliArgs.resume);
      messages.push(...data.messages);
      console.log(chalk.dim(`Resumed session "${cliArgs.resume}" (${messages.length} messages).`));
    } catch (err) {
      console.log(chalk.red(String(err instanceof Error ? err.message : err)));
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () => {
    process.stdout.write(chalk.green("\n> "));
  };

  // Ask the user to approve a destructive tool call before it runs.
  const confirmAction = (
    name: string,
    input: Record<string, unknown>
  ): Promise<boolean> =>
    new Promise((resolve) => {
      rl.question(
        chalk.yellow(`  ⚠ Run ${name}? `) +
          chalk.dim(getToolPreview(name, input)) +
          chalk.yellow("  [y/N] "),
        (ans) => resolve(/^y(es)?$/i.test(ans.trim()))
      );
    });

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      prompt();
      return;
    }

    // ── Slash commands ───────────────────────────────────────────────────────
    if (input.startsWith("/")) {
      const [cmd, ...args] = input.slice(1).split(" ");

      switch (cmd) {
        case "help":
          printHelp();
          break;

        case "clear":
          messages.length = 0;
          console.log(chalk.dim("Conversation cleared."));
          break;

        case "cost":
          printCost();
          break;

        case "cwd": {
          // Join the remaining args so directory paths that contain spaces
          // are not truncated at the first space.
          const dir = args.join(" ").trim();
          if (dir) {
            try {
              const target = path.resolve(dir);
              process.chdir(target);
              console.log(chalk.dim(`Working directory: ${process.cwd()}`));
            } catch (err) {
              console.log(chalk.red(String(err)));
            }
          } else {
            console.log(process.cwd());
          }
          break;
        }

        case "save": {
          const name = (args.join(" ").trim() || "last").replace(/\s+/g, "-");
          try {
            const file = saveSession(process.cwd(), name, config.model, messages);
            console.log(chalk.dim(`Saved session "${name}" (${messages.length} messages) → ${file}`));
          } catch (err) {
            console.log(chalk.red(String(err instanceof Error ? err.message : err)));
          }
          break;
        }

        case "resume": {
          const name = (args.join(" ").trim() || "last").replace(/\s+/g, "-");
          try {
            const data = loadSession(process.cwd(), name);
            messages.length = 0;
            messages.push(...data.messages);
            console.log(chalk.dim(`Resumed session "${name}" (${messages.length} messages).`));
          } catch (err) {
            console.log(chalk.red(String(err instanceof Error ? err.message : err)));
          }
          break;
        }

        case "sessions": {
          const names = listSessions(process.cwd());
          console.log(names.length ? "Saved sessions:\n  " + names.join("\n  ") : chalk.dim("No saved sessions."));
          break;
        }

        case "model": {
          const name = args.join(" ").trim();
          if (!name) {
            console.log(chalk.dim(`Current model: ${config.model}`));
          } else {
            config.model = name;
            console.log(chalk.dim(`Model set to ${name} for subsequent turns.`));
          }
          break;
        }

        case "exit":
        case "quit":
          printCost();
          process.exit(0);
          break;

        default:
          console.log(chalk.red(`Unknown command: /${cmd}. Type /help for help.`));
      }

      prompt();
      return;
    }

    // ── Send to Claude ───────────────────────────────────────────────────────
    messages.push({ role: "user", content: input });

    // Add cache breakpoint on the last user message to cache the conversation
    // prefix (system + prior turns) on every request
    const lastMsg = messages[messages.length - 1];
    if (typeof lastMsg.content === "string") {
      lastMsg.content = [
        {
          type: "text",
          text: lastMsg.content,
          cache_control: { type: "ephemeral" },
        },
      ];
    }

    process.stdout.write(chalk.cyan("\nClaude: "));

    try {
      await runAgenticLoop(messages, buildAgentContext(confirmAction));
      process.stdout.write("\n");
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        console.error(chalk.red(`\nAPI Error ${err.status}: ${err.message}`));
        // Remove the failed message so the user can retry
        messages.pop();
      } else {
        console.error(chalk.red("\nError: " + String(err)));
        messages.pop();
      }
    }

    prompt();
  });

  rl.on("close", () => {
    console.log(chalk.dim("\nGoodbye!"));
    printCost();
    process.exit(0);
  });

  prompt();
}

// ─── Non-interactive (print) mode ─────────────────────────────────────────────

function printCliHelp() {
  console.log(`Mentor v${VERSION} — a terminal AI coding assistant on the Anthropic API

Usage:
  mentor                     Start the interactive REPL
  mentor -p "<prompt>"       Run a single prompt and print the result, then exit
  echo "<prompt>" | mentor   Same, reading the prompt from stdin

Options:
  -p, --print <prompt>   One-shot mode: answer the prompt and exit
  --model <id>           Override the model for this run
  --resume <name>        Resume a saved session
  -y, --yes              Approve destructive actions without prompting
  -h, --help             Show this help
  -v, --version          Show the version

In one-shot mode the assistant's text goes to stdout and tool activity to
stderr, so you can pipe the answer. Destructive tools are skipped unless --yes.`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

// One-shot context: assistant text to stdout, tool activity to stderr (so the
// answer can be piped cleanly), and no interactive confirmation.
function buildPrintContext(): AgentContext {
  return {
    ...buildAgentContext(async () => config.autoApprove),
    io: {
      onText: (text) => process.stdout.write(text),
      onToolCall: (name, input) =>
        process.stderr.write(chalk.yellow(`\n[tool: ${name}] `) + chalk.dim(getToolPreview(name, input)) + "\n"),
      onToolResult: (result) =>
        process.stderr.write(result.isError ? chalk.red("  ✗ tool error\n") : chalk.dim("  ✓\n")),
      confirm: async () => config.autoApprove,
    },
  };
}

async function bootstrap() {
  // CLI flags override the resolved config for this run (help/version/errors
  // were already handled at startup, before the API-key check).
  if (cliArgs.model) config.model = cliArgs.model;
  if (cliArgs.yes) config.autoApprove = true;

  // One-shot mode when -p is given or input is piped (not a TTY).
  const piped = !process.stdin.isTTY;
  if (cliArgs.print != null || piped) {
    const promptText = cliArgs.print != null ? cliArgs.print : await readStdin();
    if (!promptText.trim()) {
      console.error(chalk.red("No prompt provided. Use -p \"<prompt>\" or pipe input, or run with --help."));
      process.exit(2);
    }
    const code = await runOnce(promptText, buildPrintContext());
    process.stdout.write("\n");
    process.exit(code);
  }

  await main();
}

bootstrap().catch((err) => {
  console.error(chalk.red("Fatal: " + String(err)));
  process.exit(1);
});
