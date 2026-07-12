import type Anthropic from "@anthropic-ai/sdk";
import type { ToolResult } from "./tools.js";

export type Message = Anthropic.MessageParam;

// ─── Injected LLM seam ────────────────────────────────────────────────────────
// A minimal interface over `client.messages.stream(...)`, so the agentic loop can
// be driven by a fake in tests without ever touching the network. The real
// Anthropic MessageStream is structurally assignable to LlmStream.

/** The subset of streaming events the loop reacts to (text streaming).
 *  Fields are optional so the full Anthropic event union stays assignable. */
export interface StreamEvent {
  type: string;
  content_block?: { type?: string };
  delta?: { type?: string; text?: string };
}

export interface LlmStream {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
  finalMessage(): Promise<Anthropic.Message>;
}

export interface LlmStreamParams {
  model: string;
  max_tokens: number;
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  messages: Message[];
}

export interface LlmClient {
  stream(params: LlmStreamParams): LlmStream;
}

// ─── Injected IO seam ─────────────────────────────────────────────────────────

export interface AgentIO {
  /** Called with each streamed text delta from the assistant. */
  onText(text: string): void;
  /** Called before a tool runs (for display). */
  onToolCall(name: string, input: Record<string, unknown>): void;
  /** Called with the result of a tool (for display). */
  onToolResult(result: ToolResult): void;
  /** Ask the user to approve a destructive tool. Return true to proceed. */
  confirm(name: string, input: Record<string, unknown>): Promise<boolean>;
}

export interface AgentContext {
  client: LlmClient;
  io: AgentIO;
  execute: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  tools: Anthropic.Tool[];
  model: string;
  maxTokens: number;
  system: Anthropic.TextBlockParam[];
  autoApprove: boolean;
  destructiveTools: Set<string>;
  onUsage?: (usage: Anthropic.Usage) => void;
}

// ─── The agentic loop ─────────────────────────────────────────────────────────
// Streams a model turn, executes any tool calls (gated by confirmation for
// destructive tools), feeds the results back, and repeats until the model stops
// asking for tools. `messages` is mutated in place to build the conversation.

export async function runAgenticLoop(messages: Message[], ctx: AgentContext): Promise<void> {
  while (true) {
    const stream = ctx.client.stream({
      model: ctx.model,
      max_tokens: ctx.maxTokens,
      system: ctx.system,
      tools: ctx.tools,
      messages,
    });

    // Stream assistant text to the IO layer in real time.
    let currentBlockType: string | null = null;
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        currentBlockType = event.content_block?.type ?? null;
      }
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        currentBlockType === "text"
      ) {
        ctx.io.onText(event.delta.text ?? "");
      }
    }

    const finalMsg = await stream.finalMessage();
    ctx.onUsage?.(finalMsg.usage);

    messages.push({ role: "assistant", content: finalMsg.content });

    if (finalMsg.stop_reason !== "tool_use") {
      return; // no more tool calls — the turn is complete
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of finalMsg.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as Record<string, unknown>;

      ctx.io.onToolCall(block.name, input);

      if (ctx.destructiveTools.has(block.name) && !ctx.autoApprove) {
        const approved = await ctx.io.confirm(block.name, input);
        if (!approved) {
          ctx.io.onToolResult({ output: "Skipped — declined by user.", isError: true });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "User declined to run this action.",
            is_error: true,
          });
          continue;
        }
      }

      const result = await ctx.execute(block.name, input);
      ctx.io.onToolResult(result);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.output,
        is_error: result.isError,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// ─── One-shot (non-interactive) run ───────────────────────────────────────────
// Runs a single prompt to completion and returns a process exit code: 0 on
// success, 1 if the model call or a fatal error occurs. Text streams through
// ctx.io.onText as usual. Used by print mode (`mentor -p "…"`).

export async function runOnce(prompt: string, ctx: AgentContext): Promise<number> {
  const messages: Message[] = [{ role: "user", content: prompt }];
  try {
    await runAgenticLoop(messages, ctx);
    return 0;
  } catch {
    return 1;
  }
}
