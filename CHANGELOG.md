# Changelog

All notable changes to Mentor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-07-12

A major, backward-compatible expansion turning the compact v1 clone into a safe,
transparent, testable, project-aware terminal coding assistant. The seven tools
and their contracts are unchanged; every addition is built test-first and is
either a pure deterministic function or driven through a dependency-injected core.

### Added

- **Dependency-injected agentic core** (`src/agent.ts`): the loop is extracted
  behind an injected `LlmClient` and `AgentIO` seam and unit-tested with a fake
  client — tool execution, confirm approve/deny, error feedback, multi-turn,
  and per-turn usage — with no network.
- **Real diff previews** (`src/diff.ts`): a pure line diff (prefix/suffix trim +
  LCS, block-replace fallback) renders a colored, context-folded `+/-` diff before
  any `edit_file` / `write_file`.
- **Dangerous-command classifier** (`src/safety.ts`): `bash` commands are rated
  normal / caution / danger (`rm -rf /`, `curl | sh`, `dd`/`mkfs` to a device,
  fork bombs, force-push, `sudo`, recursive `chmod 777`, shutdown) and flagged
  loudly; the approval gate is unchanged and still required.
- **Project memory + config** (`src/config.ts`): `.mentorrc.json` (model,
  maxTokens, autoApprove, extraDenylist) merged with env vars (env wins,
  fail-loud on malformed input), and a `MENTOR.md` / `AGENTS.md` folded into the
  cached system prompt. `extraDenylist` can only grow the sensitive-path guard.
- **Non-interactive print mode**: `mentor -p "…"` or piped stdin answers one
  prompt and exits with a status code (answer to stdout, tool activity to stderr).
  Powered by a pure argv parser (`src/cli-args.ts`) and a tested `runOnce`.
- **Session persistence** (`src/session.ts`): `/save`, `/resume`, `/sessions`, and
  `--resume` store schema-versioned transcripts under `.mentor/sessions/`, which
  is made self-ignoring so transcripts never land in git. Session names are
  validated against path traversal; parsing fails loud.
- **Accurate multi-model cost + `/model`** (`src/pricing.ts`): usage is tracked
  per model and `/cost` prices each with its own family rates; unknown models are
  labelled estimates. `/model <id>` switches the model mid-session.
- **Resilient API calls**: each model turn retries transient failures
  (429 / 5xx / 529 / network) with exponential backoff and an injected sleep,
  only when nothing has streamed yet, so text is never double-printed.
- **Tooling**: ESLint (flat config) + `npm run lint`, a Node 22/24 CI matrix with
  a lint step, a version-lockstep test, and a hostile-input sweep over the pure
  modules.

### Changed

- **Honest identity**: the system prompt now says Mentor is Mentor, an assistant
  built on the Anthropic API, instead of claiming to be Claude Code.
- `npm test` builds and runs all `dist/**/*.test.js`, so new test files are picked
  up automatically.
- The version string lives in `src/version.ts` as the single source of truth, kept
  in lockstep with `package.json` and the README by a test.

## [1.0.0]

- Initial release: a terminal Claude Code–style agent over the Anthropic Messages
  API — a streaming agentic loop with a cached system prompt, seven tools
  (read/write/edit/bash/glob/grep/ask_user), a destructive-action confirmation
  gate, a sensitive-path denylist, and a ReDoS guard, with the tool layer tested.
