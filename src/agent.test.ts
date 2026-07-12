import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  runAgenticLoop,
  runOnce,
  type LlmClient,
  type LlmStream,
  type AgentContext,
  type Message,
} from "./agent.js";
import type { ToolResult } from "./tools.js";

// ─── A fake LLM client that replays scripted turns ───────────────────────────
// Lets us drive the whole agentic loop deterministically, with no network.

interface ScriptedTurn {
  text?: string;
  toolUses?: { id: string; name: string; input: Record<string, unknown> }[];
  usage?: Partial<Anthropic.Usage>;
}

function makeFinalMessage(turn: ScriptedTurn): Anthropic.Message {
  const content: unknown[] = [];
  if (turn.text) content.push({ type: "text", text: turn.text });
  for (const tu of turn.toolUses ?? []) {
    content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
  }
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...turn.usage,
  };
  const hasTools = (turn.toolUses ?? []).length > 0;
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason: hasTools ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage,
  } as unknown as Anthropic.Message;
}

class FakeLlmClient implements LlmClient {
  calls: Message[][] = [];
  private idx = 0;
  constructor(private turns: ScriptedTurn[]) {}

  stream(params: { messages: Message[] }): LlmStream {
    this.calls.push(structuredClone(params.messages));
    const turn = this.turns[this.idx++] ?? {};
    const events: unknown[] = [];
    if (turn.text) {
      events.push({ type: "content_block_start", content_block: { type: "text" } });
      events.push({ type: "content_block_delta", delta: { type: "text_delta", text: turn.text } });
    }
    const final = makeFinalMessage(turn);
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e as never;
      },
      async finalMessage() {
        return final;
      },
    };
  }
}

interface HarnessOpts {
  confirm?: (name: string, input: Record<string, unknown>) => Promise<boolean>;
  execute?: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  autoApprove?: boolean;
  onUsage?: (usage: Anthropic.Usage) => void;
  retry?: AgentContext["retry"];
}

function makeHarness(client: LlmClient, opts: HarnessOpts = {}) {
  const textOut: string[] = [];
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  const toolResults: ToolResult[] = [];
  const ctx: AgentContext = {
    client,
    io: {
      onText: (t) => textOut.push(t),
      onToolCall: (name, input) => toolCalls.push({ name, input }),
      onToolResult: (r) => toolResults.push(r),
      confirm: opts.confirm ?? (async () => true),
    },
    execute: opts.execute ?? (async (name) => ({ output: `ran ${name}` })),
    tools: [],
    model: "fake-model",
    maxTokens: 1000,
    system: [{ type: "text", text: "sys" }],
    autoApprove: opts.autoApprove ?? false,
    destructiveTools: new Set(["bash", "write_file", "edit_file"]),
    onUsage: opts.onUsage,
    retry: opts.retry,
  };
  return { ctx, textOut, toolCalls, toolResults };
}

// A client that throws a (retriable or not) error for the first N stream calls,
// then delegates to a working fake.
class FlakyLlmClient implements LlmClient {
  attempts = 0;
  constructor(
    private failTimes: number,
    private status: number,
    private then: FakeLlmClient,
  ) {}
  stream(params: { messages: Message[] }): LlmStream {
    if (this.attempts++ < this.failTimes) {
      const err = new Error(`http ${this.status}`) as Error & { status: number };
      err.status = this.status;
      throw err;
    }
    return this.then.stream(params);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("single text turn streams text and appends one assistant message", async () => {
  const client = new FakeLlmClient([{ text: "Hello world" }]);
  const { ctx, textOut, toolCalls } = makeHarness(client);
  const messages: Message[] = [{ role: "user", content: "hi" }];

  await runAgenticLoop(messages, ctx);

  assert.equal(textOut.join(""), "Hello world");
  assert.equal(client.calls.length, 1);
  assert.equal(toolCalls.length, 0);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, "assistant");
});

test("executes a tool call and loops back to the model with the result", async () => {
  const client = new FakeLlmClient([
    { text: "reading", toolUses: [{ id: "t1", name: "read_file", input: { file_path: "a.ts" } }] },
    { text: "done" },
  ]);
  const executed: string[] = [];
  const { ctx, textOut, toolCalls } = makeHarness(client, {
    execute: async (name) => {
      executed.push(name);
      return { output: `ran ${name}` };
    },
  });
  const messages: Message[] = [{ role: "user", content: "read a.ts" }];

  await runAgenticLoop(messages, ctx);

  assert.deepEqual(executed, ["read_file"]);
  assert.equal(toolCalls[0].name, "read_file");
  assert.equal(client.calls.length, 2);
  // history: user, assistant(turn1), user(tool_result), assistant(turn2)
  assert.equal(messages.length, 4);
  assert.equal(messages[2].role, "user");
  const toolResultMsg = messages[2].content as Anthropic.ToolResultBlockParam[];
  assert.equal(toolResultMsg[0].type, "tool_result");
  assert.equal(toolResultMsg[0].content, "ran read_file");
  // the model saw the tool result on the second call
  assert.ok(client.calls[1].length >= 3);
  assert.ok(textOut.join("").includes("done"));
});

test("a declined destructive tool is not executed and feeds back an error", async () => {
  const client = new FakeLlmClient([
    { toolUses: [{ id: "t1", name: "bash", input: { command: "rm -rf x" } }] },
    { text: "understood" },
  ]);
  const executed: string[] = [];
  const { ctx, toolResults } = makeHarness(client, {
    confirm: async () => false,
    execute: async (name) => {
      executed.push(name);
      return { output: `ran ${name}` };
    },
  });
  const messages: Message[] = [{ role: "user", content: "delete x" }];

  await runAgenticLoop(messages, ctx);

  assert.deepEqual(executed, []); // bash never ran
  assert.equal(toolResults[0].isError, true);
  const fedBack = messages[2].content as Anthropic.ToolResultBlockParam[];
  assert.equal(fedBack[0].is_error, true);
  assert.match(String(fedBack[0].content), /declined/i);
});

test("auto-approve runs destructive tools without asking for confirmation", async () => {
  const client = new FakeLlmClient([
    { toolUses: [{ id: "t1", name: "write_file", input: { file_path: "a", content: "x" } }] },
    { text: "written" },
  ]);
  let confirmCalled = false;
  const executed: string[] = [];
  const { ctx } = makeHarness(client, {
    autoApprove: true,
    confirm: async () => {
      confirmCalled = true;
      return true;
    },
    execute: async (name) => {
      executed.push(name);
      return { output: "ok" };
    },
  });

  await runAgenticLoop([{ role: "user", content: "write a" }], ctx);

  assert.equal(confirmCalled, false);
  assert.deepEqual(executed, ["write_file"]);
});

test("a non-destructive tool runs without confirmation", async () => {
  const client = new FakeLlmClient([
    { toolUses: [{ id: "t1", name: "grep", input: { pattern: "foo" } }] },
    { text: "found" },
  ]);
  let confirmCalled = false;
  const executed: string[] = [];
  const { ctx } = makeHarness(client, {
    confirm: async () => {
      confirmCalled = true;
      return true;
    },
    execute: async (name) => {
      executed.push(name);
      return { output: "ok" };
    },
  });

  await runAgenticLoop([{ role: "user", content: "grep foo" }], ctx);

  assert.equal(confirmCalled, false);
  assert.deepEqual(executed, ["grep"]);
});

test("a tool error is propagated back to the model as is_error", async () => {
  const client = new FakeLlmClient([
    { toolUses: [{ id: "t1", name: "read_file", input: { file_path: "missing" } }] },
    { text: "handled" },
  ]);
  const { ctx } = makeHarness(client, {
    execute: async () => ({ output: "boom", isError: true }),
  });
  const messages: Message[] = [{ role: "user", content: "read missing" }];

  await runAgenticLoop(messages, ctx);

  const fedBack = messages[2].content as Anthropic.ToolResultBlockParam[];
  assert.equal(fedBack[0].is_error, true);
  assert.equal(fedBack[0].content, "boom");
});

test("usage is reported for every model turn", async () => {
  const client = new FakeLlmClient([
    { toolUses: [{ id: "t1", name: "grep", input: { pattern: "x" } }], usage: { input_tokens: 10, output_tokens: 5 } },
    { text: "ok", usage: { input_tokens: 20, output_tokens: 7 } },
  ]);
  let inTotal = 0;
  let outTotal = 0;
  const { ctx } = makeHarness(client, {
    onUsage: (u) => {
      inTotal += u.input_tokens;
      outTotal += u.output_tokens;
    },
  });

  await runAgenticLoop([{ role: "user", content: "go" }], ctx);

  assert.equal(inTotal, 30);
  assert.equal(outTotal, 12);
});

test("executes multiple tool calls from a single turn in order", async () => {
  const client = new FakeLlmClient([
    {
      toolUses: [
        { id: "t1", name: "read_file", input: { file_path: "a" } },
        { id: "t2", name: "read_file", input: { file_path: "b" } },
      ],
    },
    { text: "done" },
  ]);
  const executed: string[] = [];
  const { ctx } = makeHarness(client, {
    execute: async (name, input) => {
      executed.push(`${name}:${input.file_path}`);
      return { output: "ok" };
    },
  });
  const messages: Message[] = [{ role: "user", content: "read a and b" }];

  await runAgenticLoop(messages, ctx);

  assert.deepEqual(executed, ["read_file:a", "read_file:b"]);
  const fedBack = messages[2].content as Anthropic.ToolResultBlockParam[];
  assert.equal(fedBack.length, 2);
  assert.equal(fedBack[0].tool_use_id, "t1");
  assert.equal(fedBack[1].tool_use_id, "t2");
});

// A client that always throws — models an API failure in one-shot mode.
class ThrowingLlmClient implements LlmClient {
  stream(): LlmStream {
    throw new Error("network down");
  }
}

test("runOnce returns 0 and emits the answer on success", async () => {
  const client = new FakeLlmClient([{ text: "the answer" }]);
  const { ctx, textOut } = makeHarness(client);

  const code = await runOnce("what is the answer?", ctx);

  assert.equal(code, 0);
  assert.equal(textOut.join(""), "the answer");
});

test("runOnce returns a non-zero code when the model call fails", async () => {
  const { ctx } = makeHarness(new ThrowingLlmClient());

  const code = await runOnce("hi", ctx);

  assert.equal(code, 1);
});

test("a retriable API error is retried with backoff and then succeeds", async () => {
  const good = new FakeLlmClient([{ text: "recovered" }]);
  const client = new FlakyLlmClient(2, 529, good); // overloaded twice, then ok
  const delays: number[] = [];
  const { ctx, textOut } = makeHarness(client, {
    retry: {
      maxRetries: 3,
      baseDelayMs: 10,
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  });

  await runAgenticLoop([{ role: "user", content: "go" }], ctx);

  assert.equal(client.attempts, 3); // 2 failures + 1 success
  assert.equal(textOut.join(""), "recovered");
  assert.deepEqual(delays, [10, 20]); // exponential backoff
});

test("a non-retriable error is not retried", async () => {
  const good = new FakeLlmClient([{ text: "never" }]);
  const client = new FlakyLlmClient(1, 400, good); // bad request — do not retry
  let slept = 0;
  const { ctx } = makeHarness(client, {
    retry: { maxRetries: 3, baseDelayMs: 10, sleep: async () => { slept++; } },
  });

  await assert.rejects(runAgenticLoop([{ role: "user", content: "go" }], ctx));
  assert.equal(slept, 0);
  assert.equal(client.attempts, 1);
});

test("the SDK's own connection and timeout errors are retried", async () => {
  const { APIConnectionError, APIConnectionTimeoutError } = await import("@anthropic-ai/sdk");
  for (const err of [new APIConnectionError({ message: "Connection error." }), new APIConnectionTimeoutError({})]) {
    const good = new FakeLlmClient([{ text: "recovered" }]);
    let n = 0;
    const client: LlmClient = {
      stream: (p) => {
        if (n++ === 0) throw err;
        return good.stream(p);
      },
    };
    let slept = 0;
    const { ctx, textOut } = makeHarness(client, {
      retry: { maxRetries: 3, baseDelayMs: 1, sleep: async () => { slept++; } },
    });
    await runAgenticLoop([{ role: "user", content: "go" }], ctx);
    assert.equal(textOut.join(""), "recovered");
    assert.equal(slept, 1); // proves it retried rather than throwing
  }
});

test("retries are bounded and the error propagates once exhausted", async () => {
  const good = new FakeLlmClient([{ text: "unreached" }]);
  const client = new FlakyLlmClient(99, 503, good); // always fails
  const { ctx } = makeHarness(client, {
    retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
  });

  await assert.rejects(runAgenticLoop([{ role: "user", content: "go" }], ctx));
  assert.equal(client.attempts, 3); // initial + 2 retries
});
