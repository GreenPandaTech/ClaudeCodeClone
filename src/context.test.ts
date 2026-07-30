import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "./agent.js";
import {
  contextWindowFor,
  estimateTextTokens,
  estimateMessagesTokens,
  analyzeContext,
  renderContextMeter,
  MESSAGE_OVERHEAD_TOKENS,
} from "./context.js";

// ─── contextWindowFor ─────────────────────────────────────────────────────────

test("contextWindowFor knows the 1M-window model families", () => {
  for (const model of ["claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"]) {
    const w = contextWindowFor(model);
    assert.equal(w.tokens, 1_000_000, model);
    assert.equal(w.known, true, model);
  }
});

test("contextWindowFor rates Haiku and older Sonnet/Opus revisions at 200K", () => {
  for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-3-5-sonnet-20241022"]) {
    const w = contextWindowFor(model);
    assert.equal(w.tokens, 200_000, model);
    assert.equal(w.known, true, model);
  }
});

test("contextWindowFor falls back to a conservative 200K for unknown models", () => {
  for (const model of ["totally-unknown-model", "", "gpt-oss"]) {
    const w = contextWindowFor(model);
    assert.equal(w.tokens, 200_000);
    assert.equal(w.known, false);
  }
});

// ─── estimateTextTokens ───────────────────────────────────────────────────────

test("estimateTextTokens uses a ~4 chars/token ceiling heuristic", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("abcde"), 2); // ceil, not floor
  assert.equal(estimateTextTokens("x".repeat(400)), 100);
});

// ─── estimateMessagesTokens ───────────────────────────────────────────────────

test("estimateMessagesTokens counts string content plus a per-message overhead", () => {
  assert.equal(estimateMessagesTokens([]), 0);
  const one: Message[] = [{ role: "user", content: "abcd" }];
  assert.equal(estimateMessagesTokens(one), 1 + MESSAGE_OVERHEAD_TOKENS);
});

test("estimateMessagesTokens counts text, tool_use, and tool_result blocks", () => {
  const short: Message[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "read_file", input: { file_path: "a" } },
      ],
    } as Message,
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    } as Message,
  ];
  const long: Message[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "hi".repeat(500) },
        { type: "tool_use", id: "t1", name: "read_file", input: { file_path: "a".repeat(500) } },
      ],
    } as Message,
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok".repeat(500) }],
    } as Message,
  ];
  const shortTokens = estimateMessagesTokens(short);
  const longTokens = estimateMessagesTokens(long);
  assert.ok(shortTokens > 0);
  assert.ok(longTokens > shortTokens, "longer content must estimate more tokens");
});

test("estimateMessagesTokens handles tool_result blocks whose content is a block array", () => {
  const msgs: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "nested result text" }],
        },
      ],
    } as Message,
  ];
  assert.ok(estimateMessagesTokens(msgs) > MESSAGE_OVERHEAD_TOKENS);
});

test("estimateMessagesTokens never throws on unknown block shapes", () => {
  const msgs = [
    { role: "assistant", content: [{ type: "mystery_block", payload: { a: 1 } }] },
  ] as unknown as Message[];
  const n = estimateMessagesTokens(msgs);
  assert.ok(Number.isFinite(n) && n > 0);
});

// ─── analyzeContext ───────────────────────────────────────────────────────────

function baseOpts() {
  return {
    model: "claude-sonnet-4-6",
    maxTokens: 64_000,
    systemText: "s".repeat(400), // 100 tokens
    tools: [] as unknown[],
    messages: [{ role: "user", content: "u".repeat(400) }] as Message[], // 100 + overhead
    autoCompactThreshold: 0.8,
  };
}

test("analyzeContext composes system, tool, and message estimates into a total", () => {
  const b = analyzeContext(baseOpts());
  assert.equal(b.systemTokens, 100);
  assert.equal(b.toolTokens, 0); // no tools -> no tokens
  assert.equal(b.messageTokens, 100 + MESSAGE_OVERHEAD_TOKENS);
  assert.equal(b.estimatedTotal, b.systemTokens + b.toolTokens + b.messageTokens);
  assert.equal(b.messageCount, 1);
  assert.equal(b.contextWindow, 1_000_000);
  assert.equal(b.windowKnown, true);
});

test("analyzeContext reserves maxTokens for output when computing the usable window", () => {
  const b = analyzeContext(baseOpts());
  assert.equal(b.usableWindow, 1_000_000 - 64_000);
  assert.ok(b.usedFraction > 0 && b.usedFraction < 0.01);
});

test("analyzeContext clamps the usable window to at least 1 token", () => {
  const b = analyzeContext({ ...baseOpts(), model: "claude-haiku-4-5", maxTokens: 300_000 });
  assert.equal(b.usableWindow, 1);
});

test("analyzeContext prefers measured tokens over the estimate when available", () => {
  const noMeasure = analyzeContext(baseOpts());
  assert.equal(noMeasure.measuredTokens, null);
  assert.equal(noMeasure.effectiveTokens, noMeasure.estimatedTotal);

  const measured = analyzeContext({ ...baseOpts(), measuredTokens: 800_000 });
  assert.equal(measured.measuredTokens, 800_000);
  assert.equal(measured.effectiveTokens, 800_000);
  assert.equal(measured.willAutoCompact, true); // 800K >= 80% of 936K
});

test("analyzeContext computes the auto-compact trigger from the threshold", () => {
  const b = analyzeContext(baseOpts());
  assert.equal(b.autoCompactAt, Math.floor((1_000_000 - 64_000) * 0.8));
  assert.equal(b.willAutoCompact, false);

  const atBoundary = analyzeContext({ ...baseOpts(), measuredTokens: b.autoCompactAt as number });
  assert.equal(atBoundary.willAutoCompact, true); // trigger is >=, not >

  const justUnder = analyzeContext({ ...baseOpts(), measuredTokens: (b.autoCompactAt as number) - 1 });
  assert.equal(justUnder.willAutoCompact, false);
});

test("a zero threshold disables auto-compact entirely", () => {
  const b = analyzeContext({ ...baseOpts(), autoCompactThreshold: 0, measuredTokens: 999_999_999 });
  assert.equal(b.autoCompactAt, null);
  assert.equal(b.willAutoCompact, false);
});

test("analyzeContext fails loud on malformed inputs", () => {
  assert.throws(() => analyzeContext({ ...baseOpts(), measuredTokens: -1 }), /measuredTokens/);
  assert.throws(() => analyzeContext({ ...baseOpts(), measuredTokens: Number.NaN }), /measuredTokens/);
  assert.throws(() => analyzeContext({ ...baseOpts(), autoCompactThreshold: 1 }), /threshold/i);
  assert.throws(() => analyzeContext({ ...baseOpts(), autoCompactThreshold: -0.2 }), /threshold/i);
  assert.throws(() => analyzeContext({ ...baseOpts(), autoCompactThreshold: Number.NaN }), /threshold/i);
  assert.throws(() => analyzeContext({ ...baseOpts(), maxTokens: 0 }), /maxTokens/);
});

// ─── renderContextMeter ───────────────────────────────────────────────────────

test("renderContextMeter renders a fixed-width bar with a percentage", () => {
  assert.equal(renderContextMeter(0, 20), "[--------------------] 0%");
  assert.equal(renderContextMeter(0.5, 10), "[#####-----] 50%");
  assert.equal(renderContextMeter(1, 10), "[##########] 100%");
});

test("renderContextMeter clamps the bar but reports overflow honestly", () => {
  assert.equal(renderContextMeter(1.5, 10), "[##########] 150%");
});

test("renderContextMeter is safe on negative and non-finite fractions", () => {
  assert.equal(renderContextMeter(-0.5, 10), "[----------] 0%");
  assert.equal(renderContextMeter(Number.NaN, 10), "[----------] 0%");
});
