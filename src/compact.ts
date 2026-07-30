import type { LlmClient, Message } from "./agent.js";
import { estimateMessagesTokens } from "./context.js";

// /compact and the auto-compact path. The conversation is rendered to a plain
// transcript (which sidesteps tool_use/tool_result pairing rules entirely) and
// summarized through the same injected LlmClient seam the agentic loop uses —
// so the whole thing is testable with a fake client and no network. On any
// failure the original history is left untouched: the replacement is only
// spliced in after a non-empty summary has been received.

/** Marker prefix on the replacement message, so users (and the model) can see
 *  the history was compacted rather than organically short. */
export const COMPACT_MARKER = "[Conversation history compacted — summary of the conversation so far]";

/** Cap on max_tokens for the summary call — a summary never needs the session's
 *  full output budget. */
export const COMPACT_MAX_TOKENS = 8_192;

/** Per-block character cap in the rendered transcript, so one huge tool result
 *  cannot blow up the summarization request itself. */
export const TRANSCRIPT_BLOCK_CHARS = 2_000;

const COMPACT_SYSTEM_PROMPT = `You are the conversation summarizer for Mentor, a terminal AI coding assistant.
You will be given a transcript of a coding session: user requests, assistant replies, tool calls (file reads/writes/edits, shell commands, searches) and their results.

Write a compact summary that preserves everything needed to continue the work:
- the user's overall goal and any explicit constraints or preferences they stated
- what has been done so far: files created/edited (with paths), commands run, key findings
- important technical details: APIs, function names, error messages, decisions and their reasons
- current state and what remains to be done next

Be concise but specific — prefer exact file paths, identifiers, and error text over vague descriptions. Respond with the summary only: no preamble, no headings about being a summary.`;

function truncateBlock(text: string): string {
  if (text.length <= TRANSCRIPT_BLOCK_CHARS) return text;
  return text.slice(0, TRANSCRIPT_BLOCK_CHARS) + `\n… (truncated, ${text.length} chars total)`;
}

function roleLabel(role: string): string {
  return role === "assistant" ? "Assistant" : "User";
}

// Render one content block as transcript lines, defensively: blocks can come
// from saved sessions, so unknown shapes degrade to JSON instead of throwing.
function renderBlock(role: string, block: unknown): string {
  if (typeof block === "string") return `${roleLabel(role)}: ${truncateBlock(block)}`;
  if (block === null || typeof block !== "object") {
    return `${roleLabel(role)}: ${truncateBlock(String(block ?? ""))}`;
  }
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return `${roleLabel(role)}: ${truncateBlock(typeof b.text === "string" ? b.text : "")}`;
    case "tool_use": {
      const name = typeof b.name === "string" ? b.name : "unknown";
      let inputJson: string;
      try {
        inputJson = JSON.stringify(b.input) ?? "";
      } catch {
        inputJson = "(unserializable input)";
      }
      return `${roleLabel(role)}: [tool call: ${name}] ${truncateBlock(inputJson)}`;
    }
    case "tool_result": {
      const label = b.is_error === true ? "[tool result (error)]" : "[tool result]";
      const content = b.content;
      let text: string;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .map((inner) => {
            const ib = inner as Record<string, unknown> | null;
            return ib && typeof ib === "object" && typeof ib.text === "string" ? ib.text : "";
          })
          .join("\n");
      } else {
        text = "";
      }
      return `${label} ${truncateBlock(text)}`;
    }
    default: {
      let json: string;
      try {
        json = JSON.stringify(block) ?? "";
      } catch {
        json = "(unserializable block)";
      }
      return `${roleLabel(role)}: ${truncateBlock(json)}`;
    }
  }
}

/** Render a message history as a plain-text transcript for summarization. */
export function renderTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const content: unknown = msg.content;
    if (typeof content === "string") {
      lines.push(`${roleLabel(msg.role)}: ${truncateBlock(content)}`);
    } else if (Array.isArray(content)) {
      for (const block of content) lines.push(renderBlock(msg.role, block));
    }
  }
  return lines.join("\n");
}

export interface CompactDeps {
  /** The same injected seam the agentic loop runs through. */
  client: LlmClient;
  model: string;
  /** The session's max_tokens; the summary call uses min(this, COMPACT_MAX_TOKENS). */
  maxTokens: number;
}

export interface CompactResult {
  summary: string;
  messagesBefore: number;
  messagesAfter: number;
  /** Heuristic message-token estimates (see context.ts), for honest reporting. */
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

/** Summarize the history through the DI seam and replace it in place with a
 *  single marked summary message. Returns null when there is nothing to
 *  compact. Throws (leaving the history untouched) when the model call fails
 *  or produces an empty summary. */
export async function compactHistory(messages: Message[], deps: CompactDeps): Promise<CompactResult | null> {
  if (messages.length === 0) return null;

  const estimatedTokensBefore = estimateMessagesTokens(messages);
  const messagesBefore = messages.length;
  const transcript = renderTranscript(messages);

  const stream = deps.client.stream({
    model: deps.model,
    max_tokens: Math.min(deps.maxTokens, COMPACT_MAX_TOKENS),
    system: [{ type: "text", text: COMPACT_SYSTEM_PROMPT }],
    tools: [],
    messages: [
      {
        role: "user",
        content: `Here is the conversation to summarize:\n\n${transcript}\n\nSummarize the conversation above now.`,
      },
    ],
  });

  // Drain the stream (the summary is not shown live), then collect the text.
  for await (const _event of stream) {
    void _event;
  }
  const final = await stream.finalMessage();
  const summary = final.content
    .filter((block): block is { type: "text"; text: string } & typeof block => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!summary) {
    throw new Error("Compaction produced an empty summary — history left unchanged.");
  }

  // Only now touch the history: a single user message carrying the summary.
  const replacement: Message = {
    role: "user",
    content: `${COMPACT_MARKER}\n\n${summary}`,
  };
  messages.splice(0, messages.length, replacement);

  return {
    summary,
    messagesBefore,
    messagesAfter: messages.length,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateMessagesTokens(messages),
  };
}
