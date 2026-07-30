# Changelog

All notable changes to Mentor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/).

## [2.1.0] - 2026-07-30

### Added

- **Turn-level checkpoints with `/undo` and `/changes`** (`src/checkpoints.ts`):
  before each approved `write_file` / `edit_file` is applied, the pre-image (the
  file's full prior content, or an explicit did-not-exist marker) and a sha256 of
  the post-image are recorded, grouped per user turn, under
  `.mentor/checkpoints/` — made self-ignoring exactly the way
  `.mentor/sessions/` already is. `/changes` lists every file Mentor changed this
  session, grouped by turn, with colored diffs from the existing diff renderer.
  `/undo` reverts the most recent change and `/undo turn` the whole last turn;
  a revert is refused with a diff whenever the file's current content no longer
  hashes to the recorded post-image (the user edited it since), so user edits are
  never clobbered. Old checkpoints are pruned to the last `checkpointTurns` turns
  (a new `.mentorrc.json` key, positive integer, default 20). Everything sits
  behind the existing dependency-injected execute seam and is unit-tested with
  temp dirs and a fake client — no new runtime dependencies, no network.
- **Windows-aware dangerous-command classifier** (`src/safety.ts`): the bash tool
  runs cmd.exe on win32, so the rule table now also recognises
  `del`/`erase`/`rd`/`rmdir` with `/s /q` (caution locally, danger on a drive
  root or the Windows directory), `format <drive>`, `diskpart`,
  `reg delete HKLM|HKCU`, PowerShell `Remove-Item -Recurse -Force`,
  `vssadmin delete shadows`, `taskkill /f` on system-critical processes
  (csrss, lsass, winlogon, …), and download-and-execute shapes (`iwr … | iex`,
  `Invoke-Expression` wrapped around a web request or WebClient, downloads piped
  into cmd/powershell). Keywords are matched at command position only, so benign
  strings that merely contain one (filenames, echoed messages) do not trip a
  rule, and ambiguous shapes (bare `Invoke-Expression`, local-path recursive
  deletes) rate caution rather than danger. Every POSIX rule is unchanged, with
  table-driven tests in both directions.
- **Runnable doc scripts** (`examples/`): the README's `/undo` transcript and
  classifier table are pasted output of scripts run against the real code.
  `capture-transcript.mjs` drives the real built binary through a scripted
  session — a local Messages-API replay on 127.0.0.1 stands in for the model
  (the SDK honours `ANTHROPIC_BASE_URL`), so no API key is needed and nothing
  leaves the machine — and `classifier-table.mjs` prints the table straight
  from `classifyCommand`. Regenerate either and diff against the README to
  check the docs have not drifted.

### Fixed

- **Wrapper prefixes no longer defeat the Windows rules**: `cmd /c` / `cmd /k`
  (and `cmd.exe`, including flag runs like `/d /s /c`) and unquoted
  `powershell`/`pwsh` `-Command` / `-c` prefixes found at a command position are
  stripped before matching, and every unwrapping stage is classified with the
  worst rating kept — so `cmd /c del /s /q C:\` or
  `powershell -Command Remove-Item -Recurse -Force C:\` now rate danger exactly
  like their payloads instead of slipping through as normal.
- The cmd.exe recursive-delete rule recognises concatenated switches
  (`del /s/q`, `rd/s/q`), and the vssadmin rule also flags
  `vssadmin delete shadowstorage`.
- `/changes` scopes its this-session filter per directory, so after `/cwd` a
  turn id allocated here can no longer surface an identically numbered turn a
  previous session recorded in the new directory.
- `/undo` rejects an unrecognised argument (for example `/undo 3`) instead of
  silently performing a single-change undo.

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
