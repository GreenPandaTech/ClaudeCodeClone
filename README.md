# Mentor - a terminal AI coding assistant on the Anthropic API

[![CI](https://github.com/GreenPandaTech/Mentor/actions/workflows/ci.yml/badge.svg)](https://github.com/GreenPandaTech/Mentor/actions/workflows/ci.yml)
![version](https://img.shields.io/badge/version-v2.0.0-blue)
![node](https://img.shields.io/badge/node-22%2B-green)

Mentor is a local, terminal-based AI coding assistant in the style of Claude Code. It runs an agentic loop over the Anthropic Messages API: you type a request, Claude plans and calls tools (read/write/edit files, run shell commands, search the codebase), and Mentor executes those calls in your working directory and feeds the results back until the task is done. It bills against your own pay-as-you-go API credits — no subscription.

The non-obvious part is how small and how *testable* the loop is: a single streaming call with a cached system prompt, seven tools, and a confirmation gate on anything destructive — with the whole agentic core behind a dependency-injected seam so it is unit-tested without ever hitting the network.

## What's new in v2.0.0

v2 turns the compact v1 clone into a safe, transparent, testable, project-aware assistant. Every addition is built test-first and either a pure deterministic function or driven through the injected core:

- **A tested agentic core.** The loop is extracted behind an injected LLM client and IO seam, and covered by unit tests (tool execution, confirmation approve/deny, error feedback, multi-turn, per-turn usage) using a fake client — no network.
- **Real diff previews.** Before any `edit_file` / `write_file`, Mentor shows a colored, context-folded `+/-` diff of exactly what will change, not a one-line summary.
- **A dangerous-command classifier.** `bash` calls are rated normal / caution / danger (`rm -rf /`, `curl | sh`, `dd` to a device, fork bombs, force-push, `sudo`, …) and flagged loudly. The approval gate is unchanged and still required for everything.
- **Project memory + config.** A `MENTOR.md` (or `AGENTS.md`) in the working directory is folded into the system prompt, and a `.mentorrc.json` sets the model, token budget, auto-approve, and extra denied files.
- **Non-interactive mode.** `mentor -p "…"` or piped stdin answers one prompt and exits with a status code — answer on stdout, tool activity on stderr, so it pipes cleanly.
- **Session persistence.** `/save`, `/resume`, `/sessions`, and `--resume` store transcripts locally under `.mentor/sessions/` (which is made self-ignoring so they never land in git).
- **Accurate multi-model cost + `/model`.** `/cost` prices each model you actually used (opus / sonnet / haiku rates), and `/model <id>` switches mid-session.
- **Resilient API calls.** Transient failures (429 / 5xx / overloaded / network) are retried with exponential backoff.
- **Honest identity.** Mentor says it is Mentor, an assistant built on the Anthropic API — not that it is Claude Code.

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

Before any file write, edit, or shell command runs, Mentor prints the exact action — a full colored diff for edits, a heightened warning for risky shell commands — and asks for confirmation (`y/N`). Set `AUTO_APPROVE=1` (or pass `--yes`) to skip the prompt, at the cost of the safety gate.

### One-shot / scripted mode

```bash
mentor -p "summarize the architecture of this repo"     # answer to stdout, then exit
echo "what does src/index.ts do?" | mentor               # prompt from stdin
mentor -p "run the tests and fix any failures" --yes     # allow tool actions non-interactively
```

In one-shot mode the assistant's text goes to stdout and tool activity to stderr, so `mentor -p "…" > answer.txt` captures just the answer. Destructive tools are skipped unless `--yes`. Exit code is `0` on success, non-zero on failure.

### Slash commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/clear` | Clear conversation history |
| `/cost` | Token usage and estimated cost, per model |
| `/cwd <path>` | Change the working directory |
| `/model [id]` | Show or switch the model for later turns |
| `/save [name]` | Save this conversation to `.mentor/sessions` |
| `/resume [name]` | Load a saved conversation |
| `/sessions` | List saved sessions |
| `/exit` | Exit (`/quit` also works) |

### Configuration & project memory

Drop a `.mentorrc.json` in your project root to set defaults:

```json
{
  "model": "claude-sonnet-4-6",
  "maxTokens": 64000,
  "autoApprove": false,
  "extraDenylist": ["secrets.json", "internal-notes.md"]
}
```

Environment variables (`MODEL`, `MAX_TOKENS`, `AUTO_APPROVE`) override the file. A malformed config fails loud rather than being silently ignored.

Add a `MENTOR.md` (or `AGENTS.md`) with house rules / architecture notes and Mentor folds it into its system prompt, the way Claude Code reads `CLAUDE.md`.

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

The tool layer has several guardrails — the reason this is more than a thin API wrapper:

- **Destructive-action confirmation.** `bash`, `write_file`, and `edit_file` require explicit approval before running unless auto-approve is set.
- **Diff-before-write.** File edits show a real unified diff of the change before you approve it.
- **Dangerous-command classifier.** Risky `bash` commands are flagged (caution/danger) with the reason before you approve them.
- **Sensitive-path denylist.** `read_file`, `write_file`, `edit_file`, and the `grep` walker refuse to touch credential files by name (`.env`, `id_rsa`, `credentials`), by extension (`.pem`, `.key`, `.p12`, `.pfx`), by cloud credential naming pattern (`credentials.json` and its `*-credentials.json` variants, `service-account.json`/`service_account.json`, `gcloud-service-account*.json`, `firebase-adminsdk*.json`), or by directory (`~/.ssh`, `~/.aws`, `~/.gnupg`, …). The list can be extended via `extraDenylist` but never shrunk.
- **ReDoS guard.** `grep` rejects overly long patterns and catastrophic-backtracking shapes, and the file walk has a 10-second budget and a 1000-match cap.
- **Injection-safe `edit_file`.** An edit only applies when its `old_string` matches exactly once, so an ambiguous or stale target fails loudly instead of editing the wrong place.

These are best-effort local guardrails, not a sandbox. The `bash` tool can still run arbitrary approved commands, so review what you approve.

## Cost

Uses `claude-sonnet-4-6` by default (override with `MODEL`, `.mentorrc.json`, `--model`, or `/model`). `/cost` tracks usage **per model** and prices each with its own family rates (opus / sonnet / haiku), so switching models mid-session stays accurate; an unrecognised model is priced at Sonnet-class rates and clearly labelled an estimate. The system prompt is cached (`cache_control: ephemeral`) and a cache breakpoint is set on the latest user turn, so repeated context is served at the cache-read rate.

## Scope and limitations

- Single-user terminal REPL plus a one-shot mode; sessions persist locally via `/save` but there is no server or multi-user support.
- `bash` has a fixed 30-second timeout; long-running commands are killed.
- The denylist, ReDoS guard, and command classifier are heuristics, not a security boundary. There is no sandbox or filesystem jail — Mentor operates with your user's permissions.
- Automated tests cover the tool layer and the agentic core (via a fake client), plus the pure modules (diff, config, sessions, pricing, args, safety). The thin interactive glue in `src/index.ts` is exercised manually.

## Development

```bash
npm run build   # tsc -> dist/
npm run lint    # eslint
npm test        # build, then node --test over dist/**/*.test.js
npm run dev     # tsc --watch
```

Requires Node 22+ (see the CI workflow, which runs on Node 22 and 24). Stack: TypeScript (ES modules), the `@anthropic-ai/sdk`, `chalk`, and `dotenv`.

Project layout:

```
src/
├── index.ts       # REPL, slash commands, print mode, wiring (the impure shell)
├── agent.ts       # the dependency-injected agentic loop + retry (unit-tested)
├── tools.ts       # the seven tools + guardrails
├── diff.ts        # pure line diff for edit/write previews
├── safety.ts      # dangerous-command classifier
├── config.ts      # .mentorrc.json + MENTOR.md loading
├── session.ts     # local session persistence
├── pricing.ts     # per-model token pricing
├── cli-args.ts    # argv parser for print mode
└── version.ts     # single source of truth for the version
```

## License

Proprietary - All Rights Reserved (c) 2026 GreenPandaTech - portfolio viewing only.
