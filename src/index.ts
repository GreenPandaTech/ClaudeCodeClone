#!/usr/bin/env node
import "dotenv/config";
import readline from "readline";
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import path from "path";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { VERSION } from "./version.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL = process.env.MODEL ?? "claude-sonnet-4-6";
const MAX_TOKENS = 64_000;

// Tools that modify the system require explicit confirmation before running,
// unless AUTO_APPROVE=1 (or --yes) is set.
const DESTRUCTIVE_TOOLS = new Set(["bash", "write_file", "edit_file"]);
const AUTO_APPROVE = process.env.AUTO_APPROVE === "1" || process.argv.includes("--yes");

// ─── System prompt (cached — never changes, so stays at the front of the prefix) ──

const SYSTEM_PROMPT = `You are Claude Code, an expert AI coding assistant running in the user's terminal.

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

// ─── Client ───────────────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    chalk.red("Error: ANTHROPIC_API_KEY is not set.\n") +
      chalk.dim("Create a .env file with ANTHROPIC_API_KEY=sk-ant-... or set the environment variable.")
  );
  process.exit(1);
}

const client = new Anthropic();

// ─── Types ────────────────────────────────────────────────────────────────────

type Message = Anthropic.MessageParam;

// ─── UI helpers ───────────────────────────────────────────────────────────────

function printBanner() {
  console.log(chalk.cyan.bold(`\n  Mentor v${VERSION}`));
  console.log(chalk.dim(`  Model: ${MODEL}`));
  console.log(chalk.dim(`  CWD: ${process.cwd()}`));
  console.log(chalk.dim("  Type /help for commands, Ctrl+C to exit\n"));
}

function printHelp() {
  console.log(chalk.bold("\nCommands:"));
  console.log(chalk.cyan("  /help     ") + "Show this help");
  console.log(chalk.cyan("  /clear    ") + "Clear conversation history");
  console.log(chalk.cyan("  /cost     ") + "Show approximate token usage this session");
  console.log(chalk.cyan("  /cwd <p>  ") + "Change the working directory");
  console.log(chalk.cyan("  /exit     ") + "Exit the program\n");
}

function printToolCall(name: string, input: Record<string, unknown>) {
  const label = chalk.yellow(`[tool: ${name}]`);
  const preview = getToolPreview(name, input);
  process.stdout.write(`\n${label} ${chalk.dim(preview)}\n`);
}

function getToolPreview(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return String(input.file_path);
    case "write_file": {
      const content = String(input.content ?? "");
      const lines = content.split("\n");
      const preview = lines.slice(0, 3).join("\n  ");
      const tail = lines.length > 3 ? `\n  … (${lines.length} lines total)` : "";
      return `${input.file_path}\n  ${preview}${tail}`;
    }
    case "edit_file": {
      const oldLine = String(input.old_string ?? "").split("\n")[0];
      const newLine = String(input.new_string ?? "").split("\n")[0];
      return `${input.file_path}\n  - ${oldLine}\n  + ${newLine}`;
    }
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

// ─── Token tracking ───────────────────────────────────────────────────────────

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const sessionUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function trackUsage(usage: Anthropic.Usage) {
  sessionUsage.inputTokens += usage.input_tokens;
  sessionUsage.outputTokens += usage.output_tokens;
  sessionUsage.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  sessionUsage.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

function printCost() {
  // Approximate Claude Sonnet 4.6 pricing (the default model): $3/1M input, $15/1M output, $0.30/1M cache read
  const inputCost = (sessionUsage.inputTokens / 1_000_000) * 3.0;
  const outputCost = (sessionUsage.outputTokens / 1_000_000) * 15.0;
  const cacheReadCost = (sessionUsage.cacheReadTokens / 1_000_000) * 0.3;
  const total = inputCost + outputCost + cacheReadCost;

  console.log(chalk.bold("\nSession usage:"));
  console.log(`  Input tokens:       ${sessionUsage.inputTokens.toLocaleString()}`);
  console.log(`  Output tokens:      ${sessionUsage.outputTokens.toLocaleString()}`);
  console.log(`  Cache read tokens:  ${sessionUsage.cacheReadTokens.toLocaleString()}`);
  console.log(`  Cache write tokens: ${sessionUsage.cacheWriteTokens.toLocaleString()}`);
  console.log(chalk.cyan(`  Estimated cost:     $${total.toFixed(4)}\n`));
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

async function runAgenticLoop(
  messages: Message[],
  onText: (text: string) => void,
  confirm: (name: string, input: Record<string, unknown>) => Promise<boolean>
): Promise<void> {
  while (true) {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          // Cache the system prompt — it never changes between turns
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOL_DEFINITIONS as unknown as Anthropic.Tool[],
      messages,
    });

    // Stream text to terminal in real time
    let currentBlockType: string | null = null;
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        currentBlockType = event.content_block.type;
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta" &&
        currentBlockType === "text"
      ) {
        onText(event.delta.text);
      }
    }

    const finalMsg = await stream.finalMessage();
    trackUsage(finalMsg.usage);

    // Append assistant response to history
    messages.push({ role: "assistant", content: finalMsg.content });

    if (finalMsg.stop_reason !== "tool_use") {
      // Done — no more tool calls
      process.stdout.write("\n");
      break;
    }

    // Execute all tool calls and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of finalMsg.content) {
      if (block.type !== "tool_use") continue;

      printToolCall(block.name, block.input as Record<string, unknown>);

      if (DESTRUCTIVE_TOOLS.has(block.name) && !AUTO_APPROVE) {
        const approved = await confirm(block.name, block.input as Record<string, unknown>);
        if (!approved) {
          printToolResult({ output: "Skipped — declined by user.", isError: true });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "User declined to run this action.",
            is_error: true,
          });
          continue;
        }
      }

      const result = await executeTool(block.name, block.input as Record<string, unknown>);
      printToolResult(result);

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.output,
        is_error: result.isError,
      });
    }

    // Feed results back and loop
    messages.push({ role: "user", content: toolResults });
  }
}

// ─── Main REPL ────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  const messages: Message[] = [];

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
      await runAgenticLoop(
        messages,
        (text) => process.stdout.write(text),
        confirmAction
      );
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

main().catch((err) => {
  console.error(chalk.red("Fatal: " + String(err)));
  process.exit(1);
});
