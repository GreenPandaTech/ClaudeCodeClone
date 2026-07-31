import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, Message } from "./agent.js";
import { contextWindowFor, estimateMessagesTokens } from "./context.js";

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

// Sizing for the summarization request itself. A transcript is roughly the
// size of the history it renders, so a heavily overflowed session produces a
// transcript that cannot be summarized in one call — it must be chunked, or
// /compact fails with the very context error it exists to fix.

/** Reserve for the summarizer's system prompt, request framing, and slack. */
const COMPACT_RESERVE_TOKENS = 2_000;

/** Conservative chars-per-token used when sizing the request — half the ~4
 *  display heuristic, i.e. a 2x safety margin against dense tokenization. */
const BUDGET_CHARS_PER_TOKEN = 2;

/** How many transcript characters one summarization call may carry for this
 *  model. Each rolling call fits: the chunk, the previous summary (bounded by
 *  COMPACT_MAX_TOKENS), the system prompt/framing reserve, and the
 *  COMPACT_MAX_TOKENS output — all inside the model's context window. */
export function transcriptCharBudget(model: string): number {
  const window = contextWindowFor(model).tokens;
  const inputTokens = window - 2 * COMPACT_MAX_TOKENS - COMPACT_RESERVE_TOKENS;
  return Math.max(inputTokens, 1_000) * BUDGET_CHARS_PER_TOKEN;
}

/** Split a transcript into chunks of at most budgetChars, at line boundaries
 *  where possible (a single line longer than the budget is hard-sliced). */
export function splitTranscript(transcript: string, budgetChars: number): string[] {
  if (!Number.isFinite(budgetChars) || budgetChars < 1) {
    throw new Error(`splitTranscript: budgetChars must be >= 1, got ${String(budgetChars)}`);
  }
  if (transcript.length <= budgetChars) return [transcript];

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };
  for (const line of transcript.split("\n")) {
    if (line.length > budgetChars) {
      flush();
      for (let i = 0; i < line.length; i += budgetChars) {
        chunks.push(line.slice(i, i + budgetChars));
      }
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > budgetChars) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [transcript];
}

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
  /** Test seam: overrides the per-call transcript budget (defaults to
   *  transcriptCharBudget(model)). */
  transcriptCharBudget?: number;
  /** Notified with each summarization call's API usage. Compaction calls are
   *  real API calls: without this hook their spend would be invisible to the
   *  caller's cost ledger. Reported even when the summary is rejected as
   *  empty — the tokens were spent either way. */
  onUsage?: (usage: Anthropic.Usage) => void;
}

export interface CompactResult {
  summary: string;
  messagesBefore: number;
  messagesAfter: number;
  /** Heuristic message-token estimates (see context.ts), for honest reporting. */
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  /** 1 for the common single-call case; >1 when the transcript was rolled
   *  through chunked summarization because it exceeded one call's budget. */
  chunksSummarized: number;
}

/** The user-turn text for one summarization call. Single-chunk transcripts use
 *  the plain request; multi-chunk transcripts roll the summary forward, so
 *  every call fits the window regardless of how overflowed the session was. */
function buildSummaryRequest(chunk: string, index: number, total: number, summarySoFar: string): string {
  if (total === 1) {
    return `Here is the conversation to summarize:\n\n${chunk}\n\nSummarize the conversation above now.`;
  }
  if (index === 0) {
    return `Here is part 1 of ${total} of a long conversation transcript:\n\n${chunk}\n\nSummarize this part now; later parts will follow.`;
  }
  return (
    `Summary of the conversation so far (parts 1-${index} of ${total}):\n\n${summarySoFar}\n\n` +
    `Here is part ${index + 1} of ${total} of the transcript:\n\n${chunk}\n\n` +
    `Update the summary to cover everything so far. Respond with the updated summary only.`
  );
}

/** One summarization call through the DI seam; throws on an empty summary. */
async function summarizeOnce(deps: CompactDeps, requestText: string): Promise<string> {
  const stream = deps.client.stream({
    model: deps.model,
    max_tokens: Math.min(deps.maxTokens, COMPACT_MAX_TOKENS),
    system: [{ type: "text", text: COMPACT_SYSTEM_PROMPT }],
    tools: [],
    messages: [{ role: "user", content: requestText }],
  });

  // Drain the stream (the summary is not shown live), then collect the text.
  for await (const _event of stream) {
    void _event;
  }
  const final = await stream.finalMessage();
  deps.onUsage?.(final.usage);
  const summary = final.content
    .filter((block): block is { type: "text"; text: string } & typeof block => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!summary) {
    throw new Error("Compaction produced an empty summary — history left unchanged.");
  }
  return summary;
}

/** Summarize the history through the DI seam and replace it in place with a
 *  single marked summary message. A transcript too large for one call is
 *  split and rolled through chunked summarization, so even a heavily
 *  overflowed session stays recoverable. Returns null when there is nothing
 *  to compact. Throws (leaving the history untouched) when any model call
 *  fails or produces an empty summary. */
export async function compactHistory(messages: Message[], deps: CompactDeps): Promise<CompactResult | null> {
  if (messages.length === 0) return null;

  const estimatedTokensBefore = estimateMessagesTokens(messages);
  const messagesBefore = messages.length;
  const transcript = renderTranscript(messages);
  const budget = deps.transcriptCharBudget ?? transcriptCharBudget(deps.model);
  const chunks = splitTranscript(transcript, budget);

  let summary = "";
  for (let i = 0; i < chunks.length; i++) {
    summary = await summarizeOnce(deps, buildSummaryRequest(chunks[i], i, chunks.length, summary));
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
    chunksSummarized: chunks.length,
  };
}
