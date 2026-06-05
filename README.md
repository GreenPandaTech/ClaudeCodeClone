# Claude Code Clone

A local Claude Code CLI clone powered by the Anthropic API. Uses pay-as-you-go API credits — no subscription required.

## Setup

1. **Get an API key** at [console.anthropic.com](https://console.anthropic.com)

2. **Install dependencies**
   ```bash
   npm install
   npm run build
   ```

3. **Set your API key**
   ```bash
   cp .env.example .env
   # Edit .env and add your key
   ```

4. **Run it**
   ```bash
   npm start
   # or from anywhere after npm link:
   npm link
   claude
   ```

## Usage

Just type naturally. Claude can read, write, and edit files in your working directory, run shell commands, search codebases, and ask clarifying questions.

```
> refactor the auth module to use JWTs instead of sessions
> add unit tests for the payment service
> what's the overall architecture of this project?
> fix the bug in src/parser.ts where empty strings crash the lexer
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/clear` | Clear conversation history |
| `/cost` | Show token usage and estimated cost |
| `/cwd <path>` | Change working directory |
| `/exit` | Exit |

## Tools Available to Claude

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with line numbers |
| `write_file` | Create or overwrite files |
| `edit_file` | Exact string replacement in files |
| `bash` | Run shell commands (30s timeout) |
| `glob` | Find files by pattern |
| `grep` | Search file contents by regex |
| `ask_user` | Ask you a clarifying question |

## Approximate Cost

Using `claude-opus-4-6` with prompt caching:

- **Simple question:** ~$0.001–0.005
- **Editing a file:** ~$0.01–0.05
- **Large refactor:** ~$0.05–0.20

Prompt caching reduces costs by ~90% on repeated context (the system prompt and earlier messages are cached automatically).
