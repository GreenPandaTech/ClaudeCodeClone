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

/** Does an `rm` in the command carry both a recursive and a force flag? */
function isRecursiveForceRm(cmd: string): boolean {
  const m = cmd.match(/\brm\b((?:\s+-{1,2}[a-zA-Z-]+)+)/);
  if (!m) return false;
  const flags = m[1];
  const recursive = /(^|\s)-[a-zA-Z]*r/i.test(flags) || /--recursive/.test(flags);
  const force = /(^|\s)-[a-zA-Z]*f/i.test(flags) || /--force/.test(flags);
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
];

export function classifyCommand(command: string): CommandRisk {
  const cmd = command.trim();
  let best: CommandRisk = { level: "normal", reason: "" };
  for (const rule of RULES) {
    if (rule.test(cmd) && RANK[rule.level] > RANK[best.level]) {
      best = { level: rule.level, reason: rule.reason };
    }
  }
  return best;
}
