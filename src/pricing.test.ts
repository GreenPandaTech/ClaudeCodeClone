import { test } from "node:test";
import assert from "node:assert/strict";
import { priceFor, costOf, estimateCost, type ModelUsage } from "./pricing.js";

const M = (o: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...o,
});

test("priceFor matches model families", () => {
  assert.equal(priceFor("claude-opus-4-8").known, true);
  assert.equal(priceFor("claude-sonnet-4-6").known, true);
  assert.equal(priceFor("claude-haiku-4-5").known, true);
});

test("opus is priced higher than sonnet, sonnet higher than haiku", () => {
  const opus = priceFor("claude-opus-4-8").pricing.outputPerM;
  const sonnet = priceFor("claude-sonnet-4-6").pricing.outputPerM;
  const haiku = priceFor("claude-haiku-4-5").pricing.outputPerM;
  assert.ok(opus > sonnet && sonnet > haiku);
});

test("an unknown model is flagged and falls back", () => {
  const r = priceFor("some-future-model");
  assert.equal(r.known, false);
  assert.ok(r.pricing.inputPerM > 0);
});

test("costOf applies per-million pricing", () => {
  const sonnet = priceFor("claude-sonnet-4-6").pricing;
  assert.equal(costOf(M({ inputTokens: 1_000_000 }), sonnet), sonnet.inputPerM);
  assert.equal(costOf(M({ outputTokens: 1_000_000 }), sonnet), sonnet.outputPerM);
  assert.equal(costOf(M({ cacheReadTokens: 1_000_000 }), sonnet), sonnet.cacheReadPerM);
});

test("estimateCost aggregates per model, sorted, with a total", () => {
  const est = estimateCost({
    "claude-sonnet-4-6": M({ inputTokens: 1_000_000 }),
    "claude-opus-4-8": M({ outputTokens: 1_000_000 }),
  });
  assert.deepEqual(est.lines.map((l) => l.model), ["claude-opus-4-8", "claude-sonnet-4-6"]);
  const opusOut = priceFor("claude-opus-4-8").pricing.outputPerM;
  const sonnetIn = priceFor("claude-sonnet-4-6").pricing.inputPerM;
  assert.ok(Math.abs(est.total - (opusOut + sonnetIn)) < 1e-9);
  assert.equal(est.anyUnknown, false);
});

test("estimateCost flags when any model was unknown", () => {
  const est = estimateCost({ "mystery-model": M({ inputTokens: 500 }) });
  assert.equal(est.anyUnknown, true);
});

test("estimateCost is deterministic", () => {
  const usage = { "claude-sonnet-4-6": M({ inputTokens: 123, outputTokens: 45 }) };
  assert.deepEqual(estimateCost(usage), estimateCost(usage));
});
