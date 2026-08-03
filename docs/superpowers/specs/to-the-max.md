# Mentor — to-the-max spec (v2.0.0)

> **Historical document — kept as written.** This is the plan for v2.0.0, drafted
> when the project was called **Mentor**. The project is now **TerminalAgent**, but
> the old name is left throughout this file on purpose: a past spec is a record of
> what was planned, not a description of what exists now. Some of it did not survive
> contact with the build (the CI matrix is Node 24 only, not "Node 20 + 22"). For
> the design as actually shipped, read [`../../PRD.md`](../../PRD.md) and
> [`../../TDD.md`](../../TDD.md).

## Theme

Mentor v1 is a compact, well-guarded Claude Code–style terminal agent: seven tools,
a streaming agentic loop with prompt caching, a destructive-action confirmation gate,
a sensitive-path denylist, and a ReDoS guard. Its weaknesses are exactly the ones that
separate a *toy* clone from a real coding assistant:

- The agentic loop and REPL (`src/index.ts`) have **zero automated test coverage** — only
  the tool layer is tested.
- No linter; an outdated default model; a system prompt that literally claims
  "You are Claude Code" (dishonest for a portfolio clone).
- None of the things a real coding assistant needs: project memory, a config file,
  a scriptable non-interactive mode, session persistence, accurate multi-model cost,
  API retry, or a real diff preview before it overwrites your files.

**v2 turns it into a safe, transparent, testable, project-aware agentic coding assistant.**
Every addition is built test-first, strengthens (never weakens) the safety posture, and is
either a pure deterministic function or driven through a dependency-injected core so it can
be tested without ever calling the real API. The v1 tool behaviour and CLI stay backward
compatible.

Target version: **v2.0.0** (package.json currently declares 1.0.0 as the baseline; this is a
major, additive expansion). package.json, `src/version.ts`, the banner, and the README are
kept in lockstep and guarded by a test.

## Hard gates (must hold at every step)

- **Safety never regresses.** The confirmation gate, sensitive-path denylist, and ReDoS guard
  stay; new features only add guardrails. No feature silently bypasses a gate.
- **Privacy / local-first.** No network calls except the Anthropic API the user opted into.
  Session files and config are local, contain only the user's own transcript, and never store
  secrets or API keys.
- **Honesty.** Mentor identifies as Mentor, not Claude Code. `/cost` is accurate for the model
  actually used. Docs claim only what the code does.
- **Determinism where it matters.** Pure functions (diff, pricing, config parse, session
  serialise, arg parse, command classifier) are deterministic and fully tested, including
  hostile input (fail loud, never a confidently-wrong result).
- **TDD.** Failing test first, watched fail, minimal code to green, per increment. Commit +
  push each green step. Build + lint + full test suite green before any claim.

## Build order

### Step 0 — Tooling & test seam
- Add ESLint (flat config, `typescript-eslint`) + `npm run lint`; expand CI with a lint step and
  a Node 20 + 22 matrix.
- Switch `npm test` to build then run **all** `dist/**/*.test.js`, so new test files are picked up.
- Extract `src/version.ts` as the single source of truth for the version string; `index.ts`
  imports it.

### Step 1 — Dependency-injected agentic core (keystone)
- Extract the loop out of `index.ts` into `src/agent.ts`: `runAgenticLoop(messages, deps)` where
  `deps` supplies an injected `LlmClient` interface (a thin seam over `client.messages.stream`)
  and an `AgentIO` (onText, tool-call/result reporting, confirm). No behavioural change to the
  real run.
- Tests with a **fake** `LlmClient` scripted to emit text / tool_use turns: single-turn text,
  multi-turn tool execution, confirm→approve runs the tool, confirm→deny feeds back a declined
  result, tool error propagates as `is_error`, correct stop-reason termination, and the
  message-history shape fed back to the model.

### Step 2 — Real diff preview + dangerous-command classifier
- `src/diff.ts`: a pure LCS-based unified line diff. The confirmation preview for `edit_file`
  (and `write_file` over an existing file) shows the actual `+`/`-` diff, not just the first line.
- `src/safety.ts`: `classifyCommand(cmd) → { level: 'normal'|'caution'|'danger', reason }` for
  `bash` (rm -rf, `dd`, mkfs, force-push, `curl|sh` / `wget|sh`, `sudo`, `chmod -R 777`, fork
  bombs). The gate surfaces a heightened warning for caution/danger; it never auto-blocks
  (bash is opt-in by design) and never downgrades the existing confirmation.
- Both are pure and fully tested, including that a `danger` classification still requires the
  same explicit approval.

### Step 3 — Project memory + config + honest identity
- `src/config.ts`: `loadConfig(cwd, env)` merges a `.mentorrc.json` (model, autoApprove,
  maxTokens, extraDenylist[]) with environment variables (env wins), fail-loud on malformed JSON.
- `loadProjectContext(cwd)`: read `MENTOR.md` (or `AGENTS.md`) from the working directory and
  append it to the system prompt, like CLAUDE.md; bounded in size (truncate with a notice).
- Wire `extraDenylist` into `isSensitivePath` (denylist can only grow).
- Fix the system-prompt identity to **Mentor** (an assistant built on the Anthropic API), not
  "You are Claude Code". Pure loaders, tested (present / absent / malformed / oversized).

### Step 4 — Non-interactive print mode
- `src/cli-args.ts`: a pure argv parser (`-p/--print <prompt>`, `--yes`, `--model`, `--resume`,
  `--help`, `--version`), fully tested.
- `mentor -p "…"` or piped stdin runs one turn through the DI core, prints the final assistant
  text to stdout, and exits with a status code (0 success, non-zero on API/tool error). Tested
  end-to-end with a fake client.

### Step 5 — Session persistence
- `src/session.ts`: `serializeSession` / `parseSession` to `.mentor/sessions/<name>.json`
  (whitelisted fields only, schema-versioned, no secrets). `/save [name]`, `/resume [name]`,
  `/sessions`, and `--resume <name>`. Round-trip + hostile (corrupt / wrong-version file fails
  loud, never a half-loaded state) tests.

### Step 6 — Accurate multi-model cost + /model
- `src/pricing.ts`: per-model price table + `estimateCost(usageByModel)`; usage is tracked
  per model. `/model <name>` switches at runtime; `/cost` prices each model correctly and shows
  a breakdown. Update the default model to a current id. Pure, tested (unknown model → labelled
  estimate, never a silent wrong number).

### Step 7 — Resilient API + retry
- Wrap the injected client call in retry-with-exponential-backoff on 429 / 5xx / overloaded,
  with an **injected** sleep so tests are deterministic; a flaky fake client that fails then
  succeeds is covered. Clean Ctrl-C cancellation of an in-flight turn.

### Step 8 — Docs + determinism/hostile sweep + version lockstep
- README v2 (honest framing of every new capability), CHANGELOG v2.0.0, a version-lockstep test
  (package.json == `src/version.ts` == README badge/claim), and a consolidated hostile-input
  sweep over the pure modules.

### Step 9 — Release
- Final adversarial 3-lens review (security / correctness / honesty+determinism), each finding
  reproduced and fixed with a regression test; merge `--no-ff` to main; tag **v2.0.0**; delete
  the feature branch; verify CI green; update memory.

## Non-goals
- No real sandbox/jail (documented as out of scope; the guardrails are best-effort, as in v1).
- No multi-user server, no web UI, no MCP. Single-user terminal + scriptable one-shot only.
- No change to the seven tools' core contracts (only additive guardrails and previews).
