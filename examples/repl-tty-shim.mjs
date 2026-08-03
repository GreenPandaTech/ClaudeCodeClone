// Marks piped stdin as a TTY so dist/index.js starts its interactive REPL
// instead of one-shot mode, letting capture-transcript.mjs drive the real
// binary over a pipe. Used only by the capture script — TerminalAgent is unmodified.
process.stdin.isTTY = true;
await import(new URL("../dist/index.js", import.meta.url));
