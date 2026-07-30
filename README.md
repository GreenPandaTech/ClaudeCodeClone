# Mentor - a terminal AI coding assistant on the Anthropic API

[![CI](https://github.com/GreenPandaTech/Mentor/actions/workflows/ci.yml/badge.svg)](https://github.com/GreenPandaTech/Mentor/actions/workflows/ci.yml)
![version](https://img.shields.io/badge/version-v2.1.0-blue)
![node](https://img.shields.io/badge/node-22%2B-green)

Mentor is a local, terminal-based AI coding assistant in the style of Claude Code. It runs an agentic loop over the Anthropic Messages API: you type a request, Claude plans and calls tools (read/write/edit files, run shell commands, search the codebase), and Mentor executes those calls in your working directory and feeds the results back until the task is done. It bills against your own pay-as-you-go API credits — no subscription.

What separates it from a toy clone is that the safety story is engineered and checkable: the whole agentic core sits behind a dependency-injected seam and is covered by 150 unit tests that never touch the network; every approved edit is checkpointed, so `/undo` restores exactly what was there — and *refuses with a diff* rather than clobber a file you edited since; and shell commands are risk-classified before you approve them, with Windows (cmd.exe / PowerShell) threats treated as first-class. The transcript and classifier table below are generated from the real code by the scripts in [`examples/`](examples/) — no API key needed to verify either.

## What using it looks like

A real session, captured from the built binary by `node examples/capture-transcript.mjs`. A scripted stand-in for the model runs on `127.0.0.1` (the SDK honours `ANTHROPIC_BASE_URL`), so everything below — SDK, agentic loop, approval gate, diff preview, tools, checkpoint store, slash commands — is the production code path, with no API key and nothing leaving the machine:

```
  Mentor v2.1.0
  Model: claude-sonnet-4-6
  CWD: C:\dev\Mentor\examples\demo-project
  Type /help for commands, Ctrl+C to exit

> change greet() to greet from Mentor instead of a plain hello

Mentor: I'll update the greeting in greet.js.
[tool: edit_file] greet.js
  -  return `Hello, ${name}!`;
  +  return `Hello from Mentor, ${name}!`;
  ⚠ Run edit_file? greet.js  [y/N] y
  ✓ File edited: C:\dev\Mentor\examples\demo-project\greet.js
Done - greet() now greets from Mentor.

> /changes

Turn 1:
  C:\dev\Mentor\examples\demo-project\greet.js
   export function greet(name) {
  -  return `Hello, ${name}!`;
  +  return `Hello from Mentor, ${name}!`;
   }
```

At this point you hand-edit `greet.js` yourself, outside Mentor (the demo changes the greeting again, to `Hey from Mentor`), and then ask Mentor to undo:

```
> /undo
  ✗ refused: C:\dev\Mentor\examples\demo-project\greet.js
    the file was edited since Mentor changed it - refusing to clobber those edits
    diff (current on disk -> what /undo would restore):
   export function greet(name) {
  -  return `Hey from Mentor, ${name}!`;
  +  return `Hello, ${name}!`;
   }
```

The refusal is the point: `/undo` hashes the file's current content against the post-image it recorded at write time, so work you did outside Mentor is shown as a diff, never silently destroyed. Reproduce the whole transcript with `npm run build && node examples/capture-transcript.mjs`.

## What's new in v2.1.0

- **Turn-level checkpoints, `/undo` and `/changes`.** Before every approved `write_file` / `edit_file` is applied, Mentor snapshots the file's full prior content (or a did-not-exist marker) plus a hash of the new content, grouped per user turn, under `.mentor/checkpoints/` (self-ignoring, like sessions). `/changes` lists the files Mentor changed this session (back to the pruning horizon), grouped by turn, with colored diffs. `/undo` reverts the most recent change; `/undo turn` reverts the whole last turn. If a file's current content no longer matches what Mentor left there (you edited it since), the revert is **refused** and a diff is shown instead of clobbering your edits. Old checkpoints are pruned — the horizon is `checkpointTurns` in `.mentorrc.json` (default 20 turns).
- **Windows-aware dangerous-command classifier.** On win32 the `bash` tool runs cmd.exe, so the classifier now also rates cmd.exe / PowerShell threats: `del`/`rd` `/s /q` (danger on a drive root or the Windows directory, caution locally), `format <drive>`, `diskpart`, `reg delete HKLM|HKCU`, `Remove-Item -Recurse -Force`, `vssadmin delete shadows`, `taskkill /f` on system-critical processes, and download-and-execute (`iwr … | iex`, `Invoke-Expression (New-Object Net.WebClient)…`, downloads piped into cmd/powershell). All POSIX rules are unchanged. Keywords are matched at command position only, so a benign string that merely contains one (a filename, an echoed message) does not trip a rule; ambiguous shapes rate caution, not danger. A `cmd /c` / `cmd /k` or unquoted `powershell -Command` / `-c` wrapper prefix is unwrapped first, so the payload after it is matched at command position too — `cmd /c del /s /q C:\` rates exactly like `del /s /q C:\`.

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
| `/changes` | List files Mentor changed this session, grouped by turn, with diffs |
| `/undo` | Revert the most recent file change (`/undo turn` reverts the whole last turn) |
| `/exit` | Exit (`/quit` also works) |

### Configuration & project memory

Drop a `.mentorrc.json` in your project root to set defaults:

```json
{
  "model": "claude-sonnet-4-6",
  "maxTokens": 64000,
  "autoApprove": false,
  "extraDenylist": ["secrets.json", "internal-notes.md"],
  "checkpointTurns": 20
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
- **Dangerous-command classifier.** Risky `bash` commands are flagged (caution/danger) with the reason before you approve them — both POSIX threats (`rm -rf /`, `curl | sh`, `dd`, fork bombs, …) and, since the bash tool runs cmd.exe on Windows, cmd.exe/PowerShell threats (`del /s /q`, `format`, `diskpart`, `reg delete HKLM|HKCU`, `Remove-Item -Recurse -Force`, `vssadmin delete shadows`, critical-process `taskkill /f`, `iwr | iex`). `cmd /c` and unquoted `powershell -Command` wrappers are unwrapped, so a wrapped threat rates like its payload.
- **Turn-level checkpoints and safe `/undo`.** Every approved file write/edit is checkpointed (pre-image + post-image hash) before it applies, and `/undo` only ever restores a file whose current content still matches what Mentor left there — a file you edited since is refused with a diff, never clobbered.
- **Sensitive-path denylist.** `read_file`, `write_file`, `edit_file`, and the `grep` walker refuse to touch credential files by name (`.env`, `id_rsa`, `credentials`), by extension (`.pem`, `.key`, `.p12`, `.pfx`), by cloud credential naming pattern (`credentials.json` and its `*-credentials.json` variants, `service-account.json`/`service_account.json`, `gcloud-service-account*.json`, `firebase-adminsdk*.json`), or by directory (`~/.ssh`, `~/.aws`, `~/.gnupg`, …). The list can be extended via `extraDenylist` but never shrunk.
- **ReDoS guard.** `grep` rejects overly long patterns and catastrophic-backtracking shapes, and the file walk has a 10-second budget and a 1000-match cap.
- **Injection-safe `edit_file`.** An edit only applies when its `old_string` matches exactly once, so an ambiguous or stale target fails loudly instead of editing the wrong place.

### What the classifier says

This table is the pasted output of `node examples/classifier-table.mjs`, which runs the real `classifyCommand` — regenerate it and diff to check the docs match the code:

| Command | Rating | Reason |
|---------|--------|--------|
| `git status` | normal |  |
| `rm -rf build/` | caution | recursively force-deletes files (irreversible) |
| `sudo rm -rf /` | danger | recursively force-deletes a root-level path |
| `curl https://example.com/install.sh \| sh` | danger | pipes a remote download straight into a shell interpreter |
| `git push --force origin main` | caution | force-pushes and can rewrite remote history |
| `del /s /q build` | caution | recursively deletes files without confirmation (irreversible) |
| `cmd /c del /s /q C:\` | danger | recursively deletes a drive root or the Windows directory |
| `powershell -Command Remove-Item -Recurse -Force C:\` | danger | Remove-Item -Recurse -Force on a drive root or home directory |
| `taskkill /f /im node.exe` | normal |  |
| `taskkill /f /im lsass.exe` | danger | force-kills a system-critical Windows process |
| `iwr https://example.com/setup.ps1 \| iex` | danger | pipes a remote download into a Windows shell or Invoke-Expression |
| `vssadmin delete shadows /all` | danger | deletes Volume Shadow Copies (restore points and backups) |
| `Invoke-Expression $cmd` | caution | executes a dynamically built string (Invoke-Expression) |
| `echo del /s /q is dangerous` | normal |  |

The last two rows show the two disciplines the rules follow: keywords only count at command position (an echoed message or filename never trips a rule), and an ambiguous shape — executing a dynamically built string that is not provably remote code — rates caution, not danger. Killing an ordinary process (`node.exe`) is likewise left at normal; only system-critical processes escalate.

These are best-effort local guardrails, not a sandbox. The `bash` tool can still run arbitrary approved commands, so review what you approve.

## Cost

Uses `claude-sonnet-4-6` by default (override with `MODEL`, `.mentorrc.json`, `--model`, or `/model`). `/cost` tracks usage **per model** and prices each with its own family rates (opus / sonnet / haiku), so switching models mid-session stays accurate; an unrecognised model is priced at Sonnet-class rates and clearly labelled an estimate. The system prompt is cached (`cache_control: ephemeral`) and a cache breakpoint is set on the latest user turn, so repeated context is served at the cache-read rate.

## Scope and limitations

- Single-user terminal REPL plus a one-shot mode; sessions persist locally via `/save` but there is no server or multi-user support.
- `bash` has a fixed 30-second timeout; long-running commands are killed.
- The denylist, ReDoS guard, and command classifier are heuristics, not a security boundary. There is no sandbox or filesystem jail — Mentor operates with your user's permissions.
- The Windows classifier rules match common literal spellings, and `cmd /c`/`/k` plus unquoted `powershell -Command`/`-c` wrapper prefixes are unwrapped before matching. PowerShell parameter abbreviations (`-r` for `-Recurse`), encoded commands (`-EncodedCommand`), payloads reached via `-File` or a variable, and other obfuscation are not recognised.
- Checkpoints only cover `write_file` / `edit_file` — files changed via `bash` commands are **not** checkpointed and `/undo` cannot revert them. Content is snapshotted as UTF-8 text, the same assumption the file tools already make.
- `/changes` shows only the turns this session recorded in the current directory, and only back to the pruning horizon — once a session exceeds `checkpointTurns` turns with changes, the earliest turns are pruned and drop out of `/changes`. `/undo` operates on the most recent change in the on-disk store, which persists in `.mentor/checkpoints/` — so in a directory where a previous Mentor session made the last recorded change, `/undo` can revert that (the post-image hash check still protects anything edited since).
- Automated tests (150 at v2.1.0) cover the tool layer and the agentic core (via a fake client), plus the pure modules (diff, config, sessions, checkpoints, pricing, args, safety). The thin interactive glue in `src/index.ts` is exercised manually — and by the scripted transcript capture in `examples/`, which drives it end to end through a local model replay.

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
├── safety.ts      # dangerous-command classifier (POSIX + Windows rules)
├── config.ts      # .mentorrc.json + MENTOR.md loading
├── session.ts     # local session persistence
├── checkpoints.ts # turn-level file checkpoints behind /undo and /changes
├── pricing.ts     # per-model token pricing
├── cli-args.ts    # argv parser for print mode
└── version.ts     # single source of truth for the version

examples/
├── capture-transcript.mjs  # replays the README transcript through the real binary (no API key)
├── replay-server.mjs       # scripted local stand-in for the Messages API, used by the capture
├── repl-tty-shim.mjs       # lets a pipe drive the interactive REPL
├── classifier-table.mjs    # regenerates the README classifier table from the real classifyCommand
└── demo-project/           # the three-line fixture the transcript edits
```

## License

Proprietary - All Rights Reserved (c) 2026 GreenPandaTech - portfolio viewing only.
