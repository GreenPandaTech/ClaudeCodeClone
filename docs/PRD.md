# PRD — TerminalAgent

**Status:** built (retrospective) · **Date:** 2026-08-03 · **Repo:** `GreenPandaTech/TerminalAgent`
**Related:** [TDD.md](TDD.md) · [APP_FLOW.md](APP_FLOW.md) · [DESIGN_BRIEF.md](DESIGN_BRIEF.md)

> Written after the fact, at v2.2.0, from the code rather than from the README's
> framing. It records what the project is actually for and where the line was
> drawn, so the next change is argued against something.

## Problem

Agentic coding assistants are opaque about the two things that matter most when
you point one at a real working tree: **what it is about to do to your files**,
and **what it will cost**. A tool that says "I'll update the greeting" and then
writes the file gives you no way to check the edit before it lands, no way to get
the previous content back, and no visibility into whether the session is one
prompt away from a context-window rejection.

That opacity is not hypothetical for the author: an assistant with a shell tool
running on a personal Windows machine has the author's own permissions over the
author's own repositories. The failure that matters is a plausible-looking `bash`
command approved in one distracted keystroke.

## Who it is for

One person: the author, on one Windows 11 machine, working on the repositories in
`C:\dev`. It is a personal tool and a portfolio artefact — it has no users beyond
its author, is not published to npm, and is not a product. Everything below is
scoped to that honestly; a feature is worth building here if it makes the author's
own sessions safer or more legible, not because a hypothetical user base wants it.

The secondary audience is a reader — an engineer or an admissions tutor — who
opens the repo to see whether the safety claims are engineering or marketing.
That audience is why the transcript and the classifier table in the README are
generated from the real code by scripts in `examples/` and can be reproduced with
no API key.

## Success looks like

- [x] No file is written or overwritten without the exact diff being shown first
      and explicitly approved (`y/N`, defaulting to no).
- [x] Every approved file write can be undone, and an undo that would destroy work
      done outside the tool is **refused with a diff** rather than performed.
- [x] Shell commands are risk-rated before approval, and the rating survives the
      obvious evasions (command chaining, `cmd /c` and `powershell -Command`
      wrappers) rather than only reading the first command on the line.
- [x] Credential files cannot be read into the model's context by accident —
      including through a symlink, a case-variant filename, or the grep walker.
- [x] `/cost` never under-reports: every real API call the session makes, including
      the ones compaction makes on its own, is in the ledger.
- [x] A long session degrades legibly rather than dying: `/context` shows where the
      window is going, and compaction recovers a session that has already
      overflowed the model entirely.
- [x] The safety-critical logic is covered by tests that never touch the network —
      205 at v2.2.0, run in CI on every push.

## Requirements

**Must**
- Seven tools: `read_file`, `write_file`, `edit_file`, `bash`, `glob`, `grep`,
  `ask_user`.
- A confirmation gate on the three tools that modify the system (`bash`,
  `write_file`, `edit_file`), bypassable only by an explicit opt-in
  (`--yes` / `AUTO_APPROVE` / config).
- A real unified diff before any write, not a summary line.
- A sensitive-path denylist that config can extend but never shrink.
- Per-model cost accounting, since the model is switchable mid-session.
- The agentic core behind an injected seam, so it is testable without the network.

**Should**
- Turn-level checkpoints with `/undo` and `/changes`.
- Project memory (`MENTOR.md` / `AGENTS.md`) folded into the cached system prompt.
- A scriptable one-shot mode that pipes cleanly (answer on stdout, tool noise on
  stderr).
- Context accounting and automatic compaction.

**Won't (this time)**
- Cancelling an in-flight turn with Ctrl+C. The v2.0.0 spec listed it; it was
  never built, and `src/` contains no `SIGINT` or `AbortController` handling.
  Ctrl+C closes the REPL and exits the process. This is written down here so it is
  not mistaken for a shipped feature.
- Serialising REPL input. Nothing stops a second prompt being submitted while a
  turn is in flight (see TDD, *Failure modes*).

## Explicitly out of scope

- **A sandbox or filesystem jail.** The guardrails are heuristics that make an
  approving human pause; they are not a security boundary, and the README says so.
  The tool runs with the user's own permissions, by design — jailing it would break
  the thing it exists to do. Anyone treating the classifier as a boundary has
  misread it.
- **Auto-blocking dangerous commands.** The classifier raises the volume; it never
  refuses. A tool that silently blocks teaches you to stop reading the prompt.
- **Multi-user, a server, a web UI, MCP.** Single-user terminal REPL plus one-shot
  mode. Sessions persist to local disk and nothing is uploaded anywhere except the
  Anthropic API call the user opted into.
- **Checkpointing files changed by `bash`.** Only `write_file` and `edit_file` are
  checkpointed. A `bash` command that rewrites a file is invisible to `/undo`, and
  the README states this rather than implying full coverage.
- **Being competitive with Claude Code.** It is a study of one, built to understand
  the design, not to replace the product it is modelled on.

## Safety and privacy

**What personal data does this touch?** None of its own. It has no accounts, no
database, no telemetry, and no network calls except to the Anthropic API. What it
*does* handle is the user's source code, and the real exposure is that any file the
model reads is sent to the API as part of the request.

**Who can see it, and who must not?** Whoever holds the machine, plus Anthropic for
whatever the tools read. The category that must never be sent is credentials, and
that is what the denylist exists for: `read_file`, `write_file`, `edit_file`, the
`grep` walker, *and* the write-preview reader all refuse `.env*`, `*.pem/.key/.p12/.pfx`,
SSH/AWS/GPG/gh directories, and cloud service-account key shapes — matched
case-insensitively and after resolving symlinks, so a link pointing at `~/.ssh/id_rsa`
is denied too. The preview path matters specifically: overwriting a credential file
would otherwise print its old contents to the terminal in the diff.

Saved sessions and checkpoints contain whatever the tools saw, so both stores live
under a `.mentor/` directory that writes itself a `.gitignore` containing `*` the
first time it is created. Transcripts cannot reach a public repo by accident.

**What happens when access is revoked?** There is no access-control model to revoke
— it is a single-user local process. The real analogue is the API key: revoke it in
the Anthropic console and every subsequent turn fails at the API. Nothing is cached
that would keep working. The key is read from the environment or a gitignored
`.env`; it is never written to a session file, a checkpoint, or a log.

**Worst outcome if this is wrong.** In order of severity: (1) a destructive `bash`
command is approved and the working tree is lost — mitigated by the classifier
banner, not prevented, and `/undo` cannot help because `bash` is not checkpointed;
(2) a credential file slips past the denylist and is sent to the API — mitigated by
the deny-by-shape rules and the fact the list can only grow; (3) `/undo` clobbers
work done outside the tool — prevented outright by the post-image hash check, which
refuses rather than guesses.

## Not doing / rejected alternatives

| Considered | Rejected because |
|---|---|
| A real tokenizer for `/context` | A dependency and a startup cost for a number that is decorative once a turn has run — the API reports authoritative usage. The ~4 chars/token heuristic is used only before the first call and is always labelled an estimate. Being visibly approximate beats being confidently wrong. |
| Compaction that keeps the last N turns verbatim | Would split `tool_use`/`tool_result` pairs and produce a history the API rejects. The whole history is summarised into one message instead — worse fidelity, but it cannot generate an invalid request. |
| Single-request compaction (the original v2.2.0 design) | Could not compact a history larger than the model's window, i.e. exactly the state `/compact` exists to rescue — a session that overflowed, or one moved to a smaller model by `/model`. Replaced with chunked rolling summarisation before release. |
| Blocking `danger`-rated commands outright | See out of scope. The gate is the human; the classifier's job is to make the human look. |
| Renaming `.mentorrc.json` / `MENTOR.md` / `.mentor/` during the 2026-08 rename to TerminalAgent | Those are a data contract, not a label. Renaming them silently orphans every existing config file, memory file, saved session and checkpoint store in every directory the tool has run in. Deferred to a major release that reads the old names first. |

## Open questions

- Should a `bash` command rated `danger` require typing the command back, rather
  than `y`? It would break the "the classifier never blocks" line, but a single `y`
  is a thin barrier in front of `rm -rf ~`. Undecided.
- The two concurrency defects in the TDD's failure-mode table are recorded, not
  fixed. Fixing them changes REPL behaviour and needs its own change.
