import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmStream, LlmStreamParams, Message } from "./agent.js";
import {
  renderTranscript,
  compactHistory,
  transcriptCharBudget,
  splitTranscript,
  COMPACT_MARKER,
  COMPACT_MAX_TOKENS,
  TRANSCRIPT_BLOCK_CHARS,
} from "./compact.js";

// ─── A fake LLM client that returns scripted summaries ───────────────────────
// The same seam the agentic loop is tested through: no network, deterministic.
// A single string answers every call; an array scripts one summary per call
// (for the chunked rolling path).

class FakeSummaryClient implements LlmClient {
  params: LlmStreamParams[] = [];
  usage = { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 };
  private calls = 0;
  constructor(private script: string | null | string[]) {}

  stream(params: LlmStreamParams): LlmStream {
    this.params.push(structuredClone(params));
    const text = Array.isArray(this.script) ? (this.script[this.calls] ?? null) : this.script;
    this.calls++;
    const content: unknown[] = text === null ? [] : [{ type: "text", text }];
    const final = {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: this.usage,
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

// Succeeds on the first call, throws on the second — for proving that a
// failure midway through the chunked path leaves the history untouched.
class FailSecondCallClient implements LlmClient {
  private inner = new FakeSummaryClient("partial summary");
  private calls = 0;
  stream(params: LlmStreamParams): LlmStream {
    this.calls++;
    if (this.calls >= 2) throw new Error("second call boom");
    return this.inner.stream(params);
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
  assert.equal(res.chunksSummarized, 1); // fits one call -> exactly one API call
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

// ─── transcriptCharBudget / splitTranscript ───────────────────────────────────

test("transcriptCharBudget scales with the model window at 2 chars/token minus reserves", () => {
  // (window - 2 * COMPACT_MAX_TOKENS - 2000 reserve) * 2 chars/token
  assert.equal(transcriptCharBudget("claude-sonnet-4-6"), (1_000_000 - 2 * COMPACT_MAX_TOKENS - 2_000) * 2);
  assert.equal(transcriptCharBudget("claude-haiku-4-5"), (200_000 - 2 * COMPACT_MAX_TOKENS - 2_000) * 2);
  assert.equal(transcriptCharBudget("unknown-model"), (200_000 - 2 * COMPACT_MAX_TOKENS - 2_000) * 2);
});

test("splitTranscript returns one chunk when the transcript fits the budget", () => {
  assert.deepEqual(splitTranscript("short", 100), ["short"]);
  assert.deepEqual(splitTranscript("", 100), [""]);
});

test("splitTranscript splits at line boundaries and loses no content", () => {
  const transcript = ["aaaa", "bbbb", "cccc"].join("\n");
  const chunks = splitTranscript(transcript, 9);
  assert.deepEqual(chunks, ["aaaa\nbbbb", "cccc"]);
  for (const c of chunks) assert.ok(c.length <= 9);
  assert.equal(chunks.join("\n"), transcript); // boundaries were newlines
});

test("splitTranscript hard-slices a single line longer than the budget", () => {
  const line = "x".repeat(25);
  const chunks = splitTranscript(line, 10);
  assert.deepEqual(chunks, ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  assert.equal(chunks.join(""), line);
});

test("splitTranscript fails loud on a nonsensical budget", () => {
  assert.throws(() => splitTranscript("t", 0), /budgetChars/);
  assert.throws(() => splitTranscript("t", Number.NaN), /budgetChars/);
});

// ─── Chunked (rolling) summarization ─────────────────────────────────────────

function longHistory(): Message[] {
  // Six 40-char user messages -> six 46-char transcript lines; with a 100-char
  // budget that splits into exactly three 2-line chunks.
  return Array.from({ length: 6 }, (_, i) => ({
    role: "user" as const,
    content: `msg${i}`.padEnd(40, "x"),
  }));
}

test("compactHistory rolls an oversized transcript through chunked summarization", async () => {
  const client = new FakeSummaryClient(["S1", "S2", "S3"]);
  const messages = longHistory();

  const res = await compactHistory(messages, {
    client,
    model: "m",
    maxTokens: 64_000,
    transcriptCharBudget: 100,
  });

  assert.ok(res);
  assert.equal(res.chunksSummarized, 3);
  assert.equal(client.params.length, 3); // one call per chunk, never one giant request
  for (const p of client.params) {
    // Every request carries at most one chunk + rolled summary, never the
    // whole transcript.
    assert.ok(!String(p.messages[0].content).includes("msg4") || !String(p.messages[0].content).includes("msg0"));
  }
  assert.match(String(client.params[0].messages[0].content), /part 1 of 3/);
  assert.match(String(client.params[0].messages[0].content), /msg0/);
  assert.match(String(client.params[1].messages[0].content), /part 2 of 3/);
  assert.match(String(client.params[1].messages[0].content), /S1/); // summary rolled forward
  assert.match(String(client.params[2].messages[0].content), /part 3 of 3/);
  assert.match(String(client.params[2].messages[0].content), /S2/);

  assert.equal(messages.length, 1);
  const content = String(messages[0].content);
  assert.ok(content.includes(COMPACT_MARKER));
  assert.ok(content.includes("S3")); // the final rolled summary wins
});

test("a failure midway through chunked summarization leaves the history untouched", async () => {
  const messages = longHistory();
  const snapshot = structuredClone(messages);

  await assert.rejects(
    compactHistory(messages, {
      client: new FailSecondCallClient(),
      model: "m",
      maxTokens: 64_000,
      transcriptCharBudget: 100,
    }),
    /second call boom/,
  );
  assert.deepEqual(messages, snapshot);
});

// ─── Usage reporting (compaction spend must be countable) ────────────────────

test("compactHistory reports every summarization call's usage through onUsage", async () => {
  const single = new FakeSummaryClient("S");
  const seenSingle: unknown[] = [];
  await compactHistory(sampleHistory(), {
    client: single,
    model: "m",
    maxTokens: 1_000,
    onUsage: (u) => seenSingle.push(u),
  });
  assert.equal(seenSingle.length, 1);
  assert.deepEqual(seenSingle[0], single.usage);

  const chunky = new FakeSummaryClient(["S1", "S2", "S3"]);
  const seenChunky: unknown[] = [];
  await compactHistory(longHistory(), {
    client: chunky,
    model: "m",
    maxTokens: 64_000,
    transcriptCharBudget: 100,
    onUsage: (u) => seenChunky.push(u),
  });
  assert.equal(seenChunky.length, 3); // one report per real API call
});

test("usage is reported even when the summary is rejected as empty — the call still cost money", async () => {
  const client = new FakeSummaryClient(null);
  const seen: unknown[] = [];
  await assert.rejects(
    compactHistory(sampleHistory(), {
      client,
      model: "m",
      maxTokens: 1_000,
      onUsage: (u) => seen.push(u),
    }),
    /empty summary/i,
  );
  assert.equal(seen.length, 1);
});
