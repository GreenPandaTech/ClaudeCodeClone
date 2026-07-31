// A best-effort classifier that flags shell commands the model asks to run as
// `normal`, `caution`, or `danger`, so the confirmation gate can shout louder for
// the scary ones. This is NOT a security boundary — the bash tool still requires
// explicit approval for everything. It exists to make an approving human pause on
// the commands that are irreversible or that fetch-and-execute remote code.

export type RiskLevel = "normal" | "caution" | "danger";

export interface CommandRisk {
  level: RiskLevel;
  reason: string;
}

const RANK: Record<RiskLevel, number> = { normal: 0, caution: 1, danger: 2 };

/** Does an `rm` in the command carry both a recursive and a force flag?
 *  Scans every flag token in the rm command segment, not just the first run,
 *  since GNU rm accepts flags before or after the operand (e.g. `rm / -rf`). */
function isRecursiveForceRm(cmd: string): boolean {
  const m = cmd.match(/\brm\b([^\n;|&]*)/);
  if (!m) return false;
  const seg = m[1];
  const recursive = /(^|\s)-[a-zA-Z]*r/i.test(seg) || /--recursive\b/.test(seg);
  const force = /(^|\s)-[a-zA-Z]*f/i.test(seg) || /--force\b/.test(seg);
  return recursive && force;
}

/** Does the command target a root-ish path (/, /*, ~, $HOME)? */
function hasRootTarget(cmd: string): boolean {
  return (
    /(\s)(\/|\/\*)(\s|$)/.test(cmd) ||
    /\s~(\/\*?)?(\s|$)/.test(cmd) ||
    /\$HOME(\/\*?)?(\s|$)/.test(cmd)
  );
}

// ─── Windows helpers ─────────────────────────────────────────────────────────
// The bash tool runs cmd.exe on win32 (see tools.ts), so the classifier must
// recognise cmd.exe and PowerShell threats too, not just POSIX ones. All the
// Windows matchers anchor the keyword at a command position (start of string or
// right after a separator), so a benign argument or filename that merely
// contains the word — "echo del /s /q is dangerous" — does not trip a rule.

/** Find `names` (a regex alternation) invoked as a command — at the start of
 *  the string or straight after ; & | ( — and return the rest of that command
 *  segment (up to the next separator), or null when not invoked. */
function commandSegment(cmd: string, names: string): string | null {
  const re = new RegExp(`(?:^|[;&|(])\\s*(?:${names})(?:\\.exe|\\.com)?\\b([^\\n;|&]*)`, "i");
  const m = cmd.match(re);
  return m ? m[1] : null;
}

/** Like commandSegment, but also treats quotes and { as separators, so cmdlets
 *  inside `powershell -Command "..."` / script blocks are still recognised. */
function psCommandSegment(cmd: string, names: string): string | null {
  const re = new RegExp(`(?:^|[;&|({"'])\\s*(?:${names})\\b([^\\n;|&]*)`, "i");
  const m = cmd.match(re);
  return m ? m[1] : null;
}

// ─── Shell-wrapper unwrapping ────────────────────────────────────────────────
// The threats above are routinely spelled through a wrapper — `cmd /c del /s
// /q C:\` or an unquoted `powershell -Command Remove-Item …` — where the real
// command sits in ARGUMENT position and a command-position anchor alone would
// never see it. classifyCommand strips wrappers found at a command position
// (keeping the separator, so the payload becomes a command position itself)
// and classifies every intermediate string, keeping the worst rating. That
// makes unwrapping strictly additive: it can surface a threat, never hide one.

/** cmd | cmd.exe invoked as a command, then any /x flags, ending in /c or /k
 *  (run-and-exit / run-and-stay), then an optionally quoted payload. */
const CMD_WRAPPER = /(^|[;&|(])(\s*)cmd(?:\.exe)?\s+(?:\/[a-z]+\s+)*\/[ck]\s+"?/i;

/** powershell | pwsh invoked as a command, then any -Flag [value] pairs,
 *  ending in -Command or -c, then an UNQUOTED payload. (Quoted payloads are
 *  already covered: psCommandSegment treats quotes as separators.) */
const PS_WRAPPER =
  /(^|[;&|(])(\s*)(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+(?:\s+[\w.]+)?\s+)*?-c(?:ommand)?\s+"?/i;

/** The command with one wrapper prefix removed (its separator kept), or null
 *  when no wrapper is found at a command position. */
function stripOneWrapper(cmd: string): string | null {
  for (const re of [CMD_WRAPPER, PS_WRAPPER]) {
    if (re.test(cmd)) return cmd.replace(re, "$1$2");
  }
  return null;
}

/** del/erase/rd/rmdir carrying both /s (recursive) and /q (quiet), any order.
 *  cmd.exe accepts concatenated switches (del /s/q, even rd/s/q), so a switch
 *  counts when its run starts at whitespace or at the segment start — a
 *  forward-slash PATH (del src/query.txt) starts at a word character and does
 *  not. */
function isCmdRecursiveDelete(cmd: string): boolean {
  const seg = commandSegment(cmd, "del|erase|rd|rmdir");
  if (seg === null) return false;
  return /(^|\s)(\/[a-z]+)*\/s\b/i.test(seg) && /(^|\s)(\/[a-z]+)*\/q\b/i.test(seg);
}

/** PowerShell Remove-Item carrying both -Recurse and -Force (full flag names —
 *  single-letter abbreviations are a documented gap of this heuristic). */
function isPsRecursiveForceRemove(cmd: string): boolean {
  const seg = psCommandSegment(cmd, "remove-item");
  if (seg === null) return false;
  return /(^|\s)-recurse\b/i.test(seg) && /(^|\s)-force\b/i.test(seg);
}

/** Does the command name a drive root (C:\, D:/, c:\*, a bare C:), the Windows
 *  system directory, or their environment-variable spellings as a target? */
function hasDriveRootTarget(cmd: string): boolean {
  return (
    /(^|[\s"'])[a-z]:[\\/]?\*?(["']|\s|$)/i.test(cmd) ||
    /[a-z]:[\\/](windows|system32)\b/i.test(cmd) ||
    /%(systemroot|systemdrive|windir)%/i.test(cmd)
  );
}

// Processes Windows cannot run without — force-killing them crashes or bricks
// the running session. Killing an ordinary app (node.exe, chrome.exe) is normal.
const CRITICAL_WINDOWS_PROCESSES = "csrss|wininit|winlogon|lsass|smss|services|svchost";

/** taskkill with /f (force) aimed at a system-critical process image. */
function isForceKillOfCriticalProcess(cmd: string): boolean {
  const seg = commandSegment(cmd, "taskkill");
  if (seg === null) return false;
  if (!/(^|\s)\/f\b/i.test(seg)) return false;
  return new RegExp(`/im\\s+"?(${CRITICAL_WINDOWS_PROCESSES})(\\.exe)?\\b`, "i").test(seg);
}

interface Rule {
  test: (cmd: string) => boolean;
  level: RiskLevel;
  reason: string;
}

const RULES: Rule[] = [
  {
    // fetch-and-execute remote code
    test: (c) => /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python|node)\b/.test(c),
    level: "danger",
    reason: "pipes a remote download straight into a shell interpreter",
  },
  {
    test: (c) => /\bdd\b[^\n]*\bof=\/dev\//.test(c) || /(^|\s)>\s*\/dev\/(sd|nvme|disk|hd)/.test(c),
    level: "danger",
    reason: "writes directly to a disk device (data loss)",
  },
  {
    test: (c) => /\bmkfs(\.\w+)?\b/.test(c) || /\bfdisk\b/.test(c),
    level: "danger",
    reason: "formats or repartitions a disk",
  },
  {
    test: (c) => /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;/.test(c),
    level: "danger",
    reason: "looks like a fork bomb",
  },
  {
    test: (c) => isRecursiveForceRm(c) && hasRootTarget(c),
    level: "danger",
    reason: "recursively force-deletes a root-level path",
  },
  {
    test: (c) => isRecursiveForceRm(c),
    level: "caution",
    reason: "recursively force-deletes files (irreversible)",
  },
  {
    test: (c) => /\bgit\s+push\b[^\n]*(--force(-with-lease)?|\s-f\b|-\w*f\b)/.test(c),
    level: "caution",
    reason: "force-pushes and can rewrite remote history",
  },
  {
    test: (c) => /\bchmod\b[^\n]*(-[a-zA-Z]*R|--recursive)[^\n]*\b(777|a\+rwx)\b/.test(c),
    level: "caution",
    reason: "recursively makes files world-writable",
  },
  {
    test: (c) => /\b(shutdown|reboot|halt|poweroff)\b/.test(c),
    level: "caution",
    reason: "powers off or reboots the machine",
  },
  {
    test: (c) => /(^|\s|&&|;|\|)\s*sudo\b/.test(c),
    level: "caution",
    reason: "runs with elevated (root) privileges",
  },

  // ─── Windows (cmd.exe / PowerShell) rules ──────────────────────────────────
  {
    test: (c) => isCmdRecursiveDelete(c) && hasDriveRootTarget(c),
    level: "danger",
    reason: "recursively deletes a drive root or the Windows directory",
  },
  {
    test: (c) => isCmdRecursiveDelete(c),
    level: "caution",
    reason: "recursively deletes files without confirmation (irreversible)",
  },
  {
    test: (c) => isPsRecursiveForceRemove(c) && (hasDriveRootTarget(c) || hasRootTarget(c)),
    level: "danger",
    reason: "Remove-Item -Recurse -Force on a drive root or home directory",
  },
  {
    test: (c) => isPsRecursiveForceRemove(c),
    level: "caution",
    reason: "recursively force-deletes files via PowerShell (irreversible)",
  },
  {
    test: (c) => {
      const seg = commandSegment(c, "format");
      return seg !== null && /(^|\s)[a-z]:(\s|$)/i.test(seg);
    },
    level: "danger",
    reason: "formats a drive (destroys its filesystem)",
  },
  {
    test: (c) => commandSegment(c, "diskpart") !== null,
    level: "danger",
    reason: "launches diskpart, which can wipe partitions and volumes",
  },
  {
    test: (c) => {
      const seg = commandSegment(c, "reg");
      return seg !== null && /^\s*delete\s+"?(hklm|hkcu|hkey_local_machine|hkey_current_user)\b/i.test(seg);
    },
    level: "danger",
    reason: "deletes registry keys under HKLM or HKCU",
  },
  {
    test: (c) => {
      const seg = commandSegment(c, "vssadmin");
      return seg !== null && /\bdelete\b/i.test(seg) && /\bshadow(s|storage)\b/i.test(seg);
    },
    level: "danger",
    reason: "deletes Volume Shadow Copies (restore points and backups)",
  },
  {
    test: (c) => isForceKillOfCriticalProcess(c),
    level: "danger",
    reason: "force-kills a system-critical Windows process",
  },
  {
    // download piped into a Windows shell or Invoke-Expression
    test: (c) =>
      /\b(curl|wget|iwr|invoke-webrequest|certutil|bitsadmin)(\.exe)?\b[^|]*\|\s*(cmd|powershell|pwsh|iex|invoke-expression)\b/i.test(c),
    level: "danger",
    reason: "pipes a remote download into a Windows shell or Invoke-Expression",
  },
  {
    // Invoke-Expression wrapped around a web request or WebClient download
    test: (c) =>
      /\b(iex|invoke-expression)\s*\(\s*(iwr|invoke-webrequest|new-object\s+(system\.)?net\.webclient)\b/i.test(c),
    level: "danger",
    reason: "downloads and executes remote code via Invoke-Expression",
  },
  {
    // Ambiguity discipline: executing a dynamically built string is suspicious
    // but not provably fetching remote code — rate caution, not danger.
    test: (c) => psCommandSegment(c, "iex|invoke-expression") !== null,
    level: "caution",
    reason: "executes a dynamically built string (Invoke-Expression)",
  },
];

/** The individual commands a chained line will actually run.
 *
 *  Every rule here is built on `String.match` without the /g flag, and the
 *  helpers stop their segment at the next separator, so a rule only ever
 *  inspects the FIRST command on the line. `rm build/tmp && rm -rf ~` was
 *  therefore rated on its harmless first half and reached the plain [y/N]
 *  prompt with no risk banner — as did `del temp.txt & del /s /q C:\`, and the
 *  same shape with vssadmin and taskkill. On an irreversible command, the
 *  mitigation the user relies on was the thing that failed.
 *
 *  Splitting here fixes that for every rule at once, rather than rule by rule.
 */
function commandSegments(cmd: string): string[] {
  return cmd
    .split(/(?:&&|\|\||;|&|\||\n)+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function classifyCommand(command: string): CommandRisk {
  // Unwrap shell wrappers stage by stage (bounded — each strip shortens the
  // string; the cap only guards against surprises). Every stage is classified
  // and the worst rating wins, so unwrapping never downgrades a command.
  const stages: string[] = [command.trim()];
  for (let i = 0; i < 8; i++) {
    const next = stripOneWrapper(stages[stages.length - 1]);
    if (next === null) break;
    stages.push(next.trim());
  }
  let best: CommandRisk = { level: "normal", reason: "" };
  for (const cmd of stages) {
    // The whole stage is still classified first, because some rules are ABOUT
    // the chaining: `curl … | sh` is only remote code execution while the pipe
    // is intact. Each segment is then classified as well, and since a rule can
    // only ever raise the rating, looking at both finds more and never less.
    //
    // A separator inside a quoted argument — a commit message, say — can yield
    // a segment that trips a rule it should not. That is the deliberate trade:
    // an unnecessary banner the user dismisses, against `rm -rf ~` arriving
    // unannotated.
    for (const piece of [cmd, ...commandSegments(cmd)]) {
      for (const rule of RULES) {
        if (rule.test(piece) && RANK[rule.level] > RANK[best.level]) {
          best = { level: rule.level, reason: rule.reason };
        }
      }
    }
  }
  return best;
}
