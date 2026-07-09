# Mentor - a terminal AI coding assistant on the Anthropic API

[![CI](https://github.com/GreenPandaTech/Mentor/actions/workflows/ci.yml/badge.svg)](https://github.com/GreenPandaTech/Mentor/actions/workflows/ci.yml)

Mentor is a local, terminal-based AI coding assistant in the style of Claude Code. It runs an agentic loop over the Anthropic Messages API: you type a request, Claude plans and calls tools (read/write/edit files, run shell commands, search the codebase), and Mentor executes those calls in your working directory and feeds the results back until the task is done. It bills against your own pay-as-you-go API credits — no subscription. The non-obvious part is how small the loop is: a single streaming call with a cached system prompt, seven tools, and a confirmation gate on anything destructive.

## Setup

1. **Get an API key** at [console.anthropic.com](https://console.anthropic.com).

2. **Install and build**
   ```bash
   npm install
   npm run build
   ```

3. **Set your API key**
   ```bash
   cp .env.example .env
   # edit .env and set ANTHROPIC_API_KEY
   ```

4. **Run it**
   ```bash
   npm start
   ```
   Or install the `mentor` command on your PATH and run it from any directory:
   ```bash
   npm link
   mentor
   ```

## Usage

Type naturally. Claude can read, write, and edit files in the current working directory, run shell commands, search the codebase, and ask clarifying questions.

```
> refactor the auth module to use JWTs instead of sessions
> add unit tests for the payment service
> what's the overall architecture of this project?
> fix the bug in src/parser.ts where empty strings crash the lexer
```

Before any file write, edit, or shell command runs, Mentor prints the exact action and asks for confirmation (`y/N`). Set `AUTO_APPROVE=1` (or pass `--yes`) to skip the prompt — useful for scripted runs, at the cost of the safety gate.

### Slash commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/clear` | Clear conversation history |
| `/cost` | Show token usage and estimated cost for this session |
| `/cwd <path>` | Change the working directory |
| `/exit` | Exit (`/quit` also works) |

### Tools available to Claude

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with line numbers (supports offset/limit) |
| `write_file` | Create or overwrite files |
| `edit_file` | Exact, unique string replacement in a file |
| `bash` | Run a shell command (30s timeout) |
| `glob` | Find files by glob pattern, sorted by modification time |
| `grep` | Search file contents by regex |
| `ask_user` | Ask you a clarifying question |

## Safety

The tool layer has a few guardrails worth calling out, because they are the reason this is more than a thin API wrapper:

- **Destructive-action confirmation.** `bash`, `write_file`, and `edit_file` require explicit approval before running unless `AUTO_APPROVE=1` / `--yes` is set.
- **Sensitive-path denylist.** `read_file`, `write_file`, `edit_file`, and the `grep` walker refuse to touch credential files by name (`.env`, `id_rsa`, `credentials`), by extension (`.pem`, `.key`, `.p12`, `.pfx`), or by directory (`~/.ssh`, `~/.aws`, `~/.gnupg`, ...).
- **ReDoS guard.** `grep` rejects overly long patterns and a small set of catastrophic-backtracking shapes before compiling the regex, and the file walk has a 10-second wall-clock budget and a 1000-match cap.
- **Injection-safe `edit_file`.** An edit only applies when its `old_string` matches exactly once, so an ambiguous or stale target fails loudly instead of editing the wrong place.

These are best-effort local guardrails, not a sandbox. The `bash` tool can still run arbitrary approved commands, so review what you approve.

## Cost

Uses `claude-sonnet-4-6` by default. The `/cost` estimate applies Sonnet 4.6 pricing: $3.00 / 1M input tokens, $15.00 / 1M output, $0.30 / 1M cache-read. The system prompt is cached (`cache_control: ephemeral`) and a cache breakpoint is set on the latest user turn, so repeated context is served at the cache-read rate (~0.1x input) rather than full price.

Override the model with the `MODEL` environment variable. Note the `/cost` figure always assumes Sonnet 4.6 pricing, so it will be inaccurate for other models.

## Scope and limitations

- Single-user terminal REPL; no persistence — history is cleared with `/clear` or on exit.
- `bash` has a fixed 30-second timeout; long-running commands are killed.
- The denylist and ReDoS guard are heuristics, not a security boundary. There is no sandbox or filesystem jail — Mentor operates with your user's permissions.
- Automated tests cover the tool layer (`src/tools.test.ts`): path/regex guards and the `read_file` / `write_file` / `edit_file` behavior — 14 tests via `node --test`. The interactive REPL in `src/index.ts` is not covered by automated tests.

## Development

```bash
npm run build   # tsc -> dist/
npm test        # node --test dist/tools.test.js  (build first)
npm run dev     # tsc --watch
```

Requires Node 22+ (see the CI workflow). Stack: TypeScript (ES modules), the `@anthropic-ai/sdk`, `chalk`, and `dotenv`.

## License

Proprietary - All Rights Reserved (c) 2026 GreenPandaTech - portfolio viewing only.
