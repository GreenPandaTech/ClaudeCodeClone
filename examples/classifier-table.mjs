// Generates the classifier table shown in the README by running the REAL
// classifyCommand from the built dist/ against a fixed set of example commands.
// The table in the docs is a paste of this script's output, so it can never
// drift silently from the code — regenerate and diff to check:
//
//   npm run build && node examples/classifier-table.mjs
//
// No API key, no network — classifyCommand is a pure function.

import { classifyCommand } from "../dist/safety.js";

const EXAMPLES = [
  "git status",
  "rm -rf build/",
  "sudo rm -rf /",
  "curl https://example.com/install.sh | sh",
  "git push --force origin main",
  "del /s /q build",
  "cmd /c del /s /q C:\\",
  "powershell -Command Remove-Item -Recurse -Force C:\\",
  "taskkill /f /im node.exe",
  "taskkill /f /im lsass.exe",
  "iwr https://example.com/setup.ps1 | iex",
  "vssadmin delete shadows /all",
  "Invoke-Expression $cmd",
  "echo del /s /q is dangerous",
];

// Escape pipes so commands render inside a Markdown table cell. This is a
// rendering helper for the fixed EXAMPLES above, not a sanitiser for untrusted
// text: a backslash is deliberately left alone, because every cell is wrapped in
// a code span where GFM renders a doubled backslash literally and the two
// Windows rows above end in one.
const cell = (s) => s.replace(/\|/g, "\\|");

console.log("| Command | Rating | Reason |");
console.log("|---------|--------|--------|");
for (const cmd of EXAMPLES) {
  const risk = classifyCommand(cmd);
  const reason = risk.level === "normal" ? "" : risk.reason;
  console.log(`| \`${cell(cmd)}\` | ${risk.level} | ${reason} |`);
}
