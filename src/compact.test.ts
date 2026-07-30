import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmStream, LlmStreamParams, Message } from "./agent.js";
import {
  renderTranscript,
  compactHistory,
  COMPACT_MARKER,
  COMPACT_MAX_TOKENS,
  TRANSCRIPT_BLOCK_CHARS,
} from "./compact.js";

// ─── A fake LLM client that returns a scripted summary ───────────────────────
// The same seam the agentic loop is tested through: no network, deterministic.

class FakeSummaryClient implements LlmClient {
  params: LlmStreamParams[] = [];
  constructor(private summaryText: string | null) {}

  stream(params: LlmStreamParams): LlmStream {
    this.params.push(structuredClone(params));
    const content: unknown[] =
      this.summaryText === null ? [] : [{ type: "text", text: this.summaryText }];
    const final = {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as Anthropic.Message;
    return {
      async *[Symbol.asyncIterator]() {
        // The summary is not streamed to the UI; nothing to yield.
      },
      async finalMessage() {
        return final;
      },
    };
  }
}

class ThrowingClient implements LlmClient {
  stream(): LlmStream {
    throw new Error("boom");
  }
}

function sampleHistory(): Message[] {
  return [
    { role: "user", content: "please fix the bug" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking now." },
        { type: "tool_use", id: "t1", name: "read_file", input: { file_path: "a.ts" } },
      ],
    } as Message,
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "line one", is_error: false }],
    } as Message,
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [{ type: "text", text: "nested text" }],
          is_error: true,
        },
      ],
    } as Message,
  ];
}

// ─── renderTranscript ─────────────────────────────────────────────────────────

test("renderTranscript renders text, tool calls, and tool results with roles", () => {
  const t = renderTranscript(sampleHistory());
  assert.match(t, /User: please fix the bug/);
  assert.match(t, /Assistant: Looking now\./);
  assert.match(t, /\[tool call: read_file\]/);
  assert.match(t, /"file_path":"a\.ts"/);
  assert.match(t, /\[tool result\][\s\S]*line one/);
  assert.match(t, /\[tool result \(error\)\][\s\S]*nested text/);
});

test("renderTranscript truncates oversized blocks and says so", () => {
  const big = "x".repeat(TRANSCRIPT_BLOCK_CHARS * 5);
  const t = renderTranscript([{ role: "user", content: big }]);
  assert.ok(t.length < big.length, "transcript must be shorter than the raw block");
  assert.match(t, /truncated/);
  assert.match(t, new RegExp(String(big.length)));
});

test("renderTranscript never throws on unknown block shapes", () => {
  const weird = [
    { role: "assistant", content: [{ type: "mystery_block", payload: { a: 1 } }] },
  ] as unknown as Message[];
  const t = renderTranscript(weird);
  assert.equal(typeof t, "string");
  assert.ok(t.length > 0);
});

// ─── compactHistory ───────────────────────────────────────────────────────────

test("compactHistory replaces the history with a single marked summary message", async () => {
  const client = new FakeSummaryClient("THE SUMMARY");
  const messages = sampleHistory();

  const res = await compactHistory(messages, { client, model: "fake-model", maxTokens: 64_000 });

  assert.ok(res);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  const content = String(messages[0].content);
  assert.ok(content.includes(COMPACT_MARKER));
  assert.ok(content.includes("THE SUMMARY"));
});

test("compactHistory reports honest before/after stats", async () => {
  const client = new FakeSummaryClient("short summary");
  const messages: Message[] = [
    { role: "user", content: "a".repeat(5_000) },
    { role: "assistant", content: [{ type: "text", text: "b".repeat(5_000) }] } as Message,
  ];

  const res = await compactHistory(messages, { client, model: "fake-model", maxTokens: 64_000 });

  assert.ok(res);
  assert.equal(res.messagesBefore, 2);
  assert.equal(res.messagesAfter, 1);
  assert.ok(res.estimatedTokensBefore > res.estimatedTokensAfter, "compaction must shrink the estimate");
  assert.equal(res.summary, "short summary");
});

test("compactHistory sends the transcript through the DI seam with no tools", async () => {
  const client = new FakeSummaryClient("SUMMARY");
  const messages = sampleHistory();

  await compactHistory(messages, { client, model: "fake-model", maxTokens: 64_000 });

  assert.equal(client.params.length, 1);
  const p = client.params[0];
  assert.equal(p.model, "fake-model");
  assert.deepEqual(p.tools, []);
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].role, "user");
  assert.match(String(p.messages[0].content), /please fix the bug/);
  assert.match(p.system[0].text, /summar/i);
});

test("compactHistory caps the summary call max_tokens", async () => {
  const big = new FakeSummaryClient("S");
  await compactHistory(sampleHistory(), { client: big, model: "m", maxTokens: 64_000 });
  assert.equal(big.params[0].max_tokens, COMPACT_MAX_TOKENS);

  const small = new FakeSummaryClient("S");
  await compactHistory(sampleHistory(), { client: small, model: "m", maxTokens: 1_000 });
  assert.equal(small.params[0].max_tokens, 1_000);
});

test("compactHistory returns null on an empty history and touches nothing", async () => {
  const client = new FakeSummaryClient("unused");
  const messages: Message[] = [];

  const res = await compactHistory(messages, { client, model: "m", maxTokens: 1_000 });

  assert.equal(res, null);
  assert.equal(messages.length, 0);
  assert.equal(client.params.length, 0); // no pointless API call
});

test("an empty or whitespace summary throws and leaves the history untouched", async () => {
  for (const bad of [null, "   \n  "]) {
    const client = new FakeSummaryClient(bad);
    const messages = sampleHistory();
    const snapshot = structuredClone(messages);

    await assert.rejects(
      compactHistory(messages, { client, model: "m", maxTokens: 1_000 }),
      /empty summary/i,
    );
    assert.deepEqual(messages, snapshot);
  }
});

test("a failing model call propagates and leaves the history untouched", async () => {
  const messages = sampleHistory();
  const snapshot = structuredClone(messages);

  await assert.rejects(
    compactHistory(messages, { client: new ThrowingClient(), model: "m", maxTokens: 1_000 }),
    /boom/,
  );
  assert.deepEqual(messages, snapshot);
});
