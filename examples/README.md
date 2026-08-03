# Runnable doc scripts

The transcript and the classifier table in the main README are not written by
hand — they are the pasted output of the scripts in this directory, run against
the real code. Regenerate either one and diff it against the README to check
the docs have not drifted. Neither script needs an API key, and nothing leaves
your machine.

## `classifier-table.mjs`

Prints the README's Markdown table of example commands and their risk ratings
by calling the real `classifyCommand` (a pure function) from the built `dist/`:

```bash
npm run build && node examples/classifier-table.mjs
```

## `capture-transcript.mjs`

Reproduces the README's `/undo` transcript by driving the **real built binary**
(`dist/index.js`) through a scripted session: the model asks to edit
`demo-project/greet.js`, the user approves, `/changes` shows the diff, the user
then hand-edits the file *outside* TerminalAgent, and `/undo` refuses with a diff
instead of clobbering the hand edit.

```bash
npm run build && node examples/capture-transcript.mjs
```

How it works with no key and no network access:

- `replay-server.mjs` is a small local stand-in for the Messages streaming API
  on `127.0.0.1`. The Anthropic SDK honours `ANTHROPIC_BASE_URL`, so TerminalAgent
  itself runs completely unmodified — the real SDK SSE parser, agentic loop,
  approval gate, tools, checkpoint store, and slash commands are all the
  production code path. Only the model's two responses are scripted.
- `repl-tty-shim.mjs` marks piped stdin as a TTY so the binary starts its
  interactive REPL (instead of one-shot mode) and can be driven over a pipe.
- `demo-project/` holds the three-line fixture the session edits. The capture
  script resets the fixture and its `.mentor/` checkpoint store before and
  after every run, so the output is deterministic run to run.
