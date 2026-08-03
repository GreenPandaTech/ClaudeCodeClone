# Design Brief — TerminalAgent's terminal UI

**Date:** 2026-08-03 · **PRD:** [PRD.md](PRD.md) · **App Flow:** [APP_FLOW.md](APP_FLOW.md)

> There is no graphical surface. The designed surface is the terminal output —
> 108 `chalk` calls in `src/index.ts` plus the diff renderer in `src/diff.ts` and
> the meter in `src/context.ts`. The web sections of the standard template
> (breakpoints, touch targets, zoom) are cut rather than padded; terminal width
> replaces them.

## Intent

**Calm until it matters, then unmissable.** Ordinary activity — reading a file,
running a search, streaming a reply — should be quiet enough to skim. The single
moment the design exists for is the half-second before someone types `y`, and at
that moment the output must be impossible to skim past.

**What it must never feel like:** a progress theatre. No spinners, no fake
percentages, no "Thinking…" while nothing streams. The tokens arriving *are* the
progress indicator, and every number shown is either measured or explicitly
labelled an estimate. A confident-looking wrong number is the specific failure
this interface is designed against.

## Who is looking at it

One developer, at their own machine, usually mid-task and slightly impatient,
approving the fourth tool call in a row. Design for the *fourth* approval, not the
first — by then the prompt has become muscle memory and the interface's only job is
to break the rhythm when the command in front of them is different in kind.

## Precedents

- **`git diff` / `diff -u`** — the `+`/`-`/space prefix carries the meaning and
  colour only reinforces it. Copied exactly: `formatDiff` emits the prefixes and
  `printDiffPreview` adds the colour on top, so a monochrome terminal loses nothing.
- **`sudo`'s password prompt** — one line, no decoration, unambiguous about what is
  about to happen. The approval prompt is one line for the same reason.
- **`apt`'s "The following packages will be REMOVED"** — the capitalised word
  carries the warning without relying on colour. `⚠ DANGER: …` uses the same trick.

## Anti-patterns for this project

- **Truncating a command in the approval preview.** `getToolPreview` truncates
  `ask_user` to 60 characters and unknown tools to 60 characters of JSON, but the
  `bash` case returns the command **in full, always** — with an explicit comment
  saying why. Truncating the one string the user is being asked to authorise would
  turn the safety gate into theatre.
- **A box-drawing frame around anything.** It breaks on `cmd.exe` code pages, wraps
  badly at narrow widths, and buys nothing.
- **Colour as the only carrier of a state.** See the accessibility floor.
- **Emoji as status.** `✓ ✗ ⚠` are used and render as text; nothing depends on an
  emoji font being present.
- **Rounding a percentage to `0%` or `100%` when it is neither.** `formatPercent`
  renders `<1%` and `>99%` instead. A meter that reads `100%` while the session
  still works would teach the user to distrust the meter.

## Type

Whatever the user's terminal uses. The only typographic decisions available are
weight and structure, and both are used sparingly: `chalk.bold` for section
headings (`Commands:`, `Session usage:`, `Context usage:`, `Turn N:`) and
`chalk.dim` for everything subordinate. Body output is unstyled — the default
weight is the baseline, not a choice.

## Colour

Roles first; the values are the terminal's own 16-colour ANSI palette, deliberately
**not** 24-bit hex, so the output adopts the user's theme instead of fighting it.

| Role | Colour | Where |
|---|---|---|
| Identity | `cyan.bold` | Banner title |
| Speaker | `cyan` | `TerminalAgent: `, slash-command names, changed filenames, cost total |
| Subordinate detail | `dim` | Model, cwd, tool results, context breakdown, unchanged diff lines |
| Invitation | `green` | The `> ` prompt, `+` diff lines, `✓ restored`, compaction success |
| Caution / pending decision | `yellow` | `[tool: …]` label, the `[y/N]` prompt, `⚠ CAUTION`, retry notices, auto-compact notice, `(est.)`, `AUTO-APPROVE is ON` |
| Failure / destruction | `red` | `✗` results, API errors, refusals, `-` diff lines |
| Irreversible | `red.bold` | `⚠ DANGER` only |

The scale is deliberately three-step — dim, default, coloured — and `bold` is
reserved almost entirely for `red.bold` on `DANGER`, so that the single most
important state in the product has a treatment nothing else uses.

**On contrast: this is honest rather than measured.** The 16 ANSI colours resolve
to whatever the user's terminal theme defines, so no fixed contrast ratio can be
claimed and none is. That is precisely why colour never carries meaning alone.

## Spacing and layout

- A leading `\n` before the prompt and before each tool call, so the transcript
  reads as discrete blocks rather than a wall.
- Two-space indent for anything subordinate to the line above (diff lines, results,
  warnings). One level only — nothing nests twice.
- Four-space indent inside `/cost` and `/context` for the numeric breakdown, which
  is the only place a third level appears and the only place a table-like alignment
  is used (`.padStart(4)` on `read_file`'s line numbers is the other).
- The context meter is fixed at 20 characters. Everything else is fluid.

## Components touched

Everything renders through five existing helpers; adding a sixth needs a reason.

| Helper | Job |
|---|---|
| `printDiffPreview` | The only place a diff is coloured — used by both `edit_file` and `write_file` previews *and* by `/changes` and refused `/undo`, so all four look identical |
| `printToolCall` / `getToolPreview` | The only place a pending tool is rendered |
| `printToolResult` | The only place a result is rendered (3 lines dim, or 5 lines red) |
| `renderContextMeter` | The only bar in the product |
| `formatPercent` | The only percentage formatter |

A near-duplicate of any of these would be a defect. The reason `/undo`'s refusal
shows the same diff renderer as the approval preview is that the user should
recognise it instantly as the same kind of object.

## States

| State | Treatment |
|---|---|
| Idle | Green `> ` |
| Streaming | Raw text, no wrapper — the only unstyled output in the product |
| Pending approval (normal) | Yellow one-liner, `[y/N]` with the capital N showing the default |
| Pending approval (caution) | Same, preceded by `⚠ CAUTION: <reason>` in yellow |
| Pending approval (danger) | Same, preceded by `⚠ DANGER: <reason>` in `red.bold` |
| Success | Dim `✓` — deliberately quieter than failure |
| Failure | Red `✗`, five lines instead of three |
| Refusal | Red `✗ refused:`, the reason, then the diff — the loudest non-danger state, because it is the one where the user must decide something |
| Degraded | Yellow. Retries, auto-compact, `maxTokens` exceeding the window, `(edited outside TerminalAgent since)` |

## Accessibility floor — non-negotiable

- **Colour is never the only signal.** Verified element by element: diffs carry
  `+`/`-`/space; results carry `✓`/`✗`; risk carries `⚠` and the literal word
  `CAUTION` or `DANGER`; estimated prices carry the text `(est.)`; the meter always
  prints its percentage as text beside the bar; a stale checkpoint carries the words
  `(edited outside TerminalAgent since)`. Strip every escape code and no meaning
  is lost.
- **`NO_COLOR` is honoured.** Verified empirically, not assumed:
  `NO_COLOR=1 node dist/index.js -p hi` produces output with zero ANSI escapes;
  `FORCE_COLOR=1` produces `^[[31m…`. chalk does this; nothing in the code
  second-guesses it.
- **ASCII for structure.** The meter is `#` and `-`, not block-drawing characters,
  so it survives `cmd.exe` and a non-UTF-8 code page. The complete set of
  non-ASCII characters `src/index.ts` can emit is `⚠ ✓ ✗ ⟳ → … —` (U+26A0, 2713,
  2717, 27F3, 2192, 2026, 2014) — all decorative, all paired with words, none
  load-bearing. There are no box-drawing characters in any output path.
- **Channel separation.** One-shot mode puts assistant text on stdout and tool
  activity on stderr, so the answer can be piped, read by a screen reader, or
  redirected without the interface noise.

## Terminal width

Replaces the responsive section.

- **Nothing is hard-wrapped.** Long lines are left to the terminal, so a wide window
  gets full lines and a narrow one soft-wraps rather than being truncated to fit an
  assumed 80 columns.
- **The `bash` preview is never shortened**, at any width. This is the one place the
  design accepts ugly wrapping in exchange for correctness (see anti-patterns).
- **Fixed-width elements are 20 characters or fewer** — the meter, the `padStart(4)`
  line numbers — so nothing overflows even at 40 columns.
- **Known gap:** the diff renderer folds *vertically* (`… (N unchanged lines)`) but
  never horizontally. A 400-character minified line in a preview will wrap into a
  wall. Not fixed, because truncating a diff line risks hiding the part of a change
  the user needed to see, and that trade sits on the same side as the `bash` rule.

## Done means

- [x] Every coloured element also carries a glyph or a word
- [x] `NO_COLOR=1` produces zero escape codes (run and checked, not assumed)
- [x] The `bash` approval preview shows the full command at every width
- [x] `DANGER` has a treatment used by nothing else
- [x] Empty and error states have real copy, not silence — see App Flow
- [x] All five render helpers are single-source; no near-duplicates
