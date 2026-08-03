// A tiny, pure argv parser for TerminalAgent's non-interactive flags. Takes
// process.argv.slice(2) and never touches process or the filesystem.

export interface ParsedArgs {
  /** One-shot prompt (-p / --print). Undefined means interactive mode. */
  print?: string;
  /** --yes: approve destructive actions without prompting. */
  yes: boolean;
  /** --model <id>: override the configured model. */
  model?: string;
  /** --resume <name>: resume a saved session. */
  resume?: string;
  help: boolean;
  version: boolean;
  /** Parse errors (e.g. a flag missing its value, or an unknown flag). */
  errors: string[];
}

// Flags that consume the following token as their value.
const VALUE_FLAGS: Record<string, keyof ParsedArgs> = {
  "-p": "print",
  "--print": "print",
  "--model": "model",
  "--resume": "resume",
};

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { yes: false, help: false, version: false, errors: [] };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token in VALUE_FLAGS) {
      const key = VALUE_FLAGS[token];
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        args.errors.push(`Flag ${token} (${key}) requires a value`);
        continue;
      }
      (args[key] as string) = value;
      i++; // consume the value token
      continue;
    }

    switch (token) {
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      default:
        if (token.startsWith("-")) {
          args.errors.push(`Unknown flag: ${token}`);
        }
        // bare positional tokens are ignored (use -p for a one-shot prompt)
    }
  }

  return args;
}
