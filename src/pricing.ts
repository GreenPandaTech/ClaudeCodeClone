// Token pricing, so /cost is accurate for whichever model was actually used
// rather than always assuming one model's rates. Prices are approximate published
// Anthropic list prices in USD per 1,000,000 tokens, matched by model family so
// the numbers stay right across exact model-id revisions. Unknown models fall
// back to Sonnet-class rates and are flagged as estimates.

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const FAMILY_PRICING: { match: RegExp; pricing: ModelPricing }[] = [
  { match: /opus/i, pricing: { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 } },
  { match: /haiku/i, pricing: { inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1 } },
  { match: /sonnet/i, pricing: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 } },
];

// Used when the model family is unrecognised (Sonnet-class rates).
const FALLBACK_PRICING: ModelPricing = {
  inputPerM: 3,
  outputPerM: 15,
  cacheReadPerM: 0.3,
  cacheWritePerM: 3.75,
};

export function priceFor(model: string): { pricing: ModelPricing; known: boolean } {
  for (const entry of FAMILY_PRICING) {
    if (entry.match.test(model)) return { pricing: entry.pricing, known: true };
  }
  return { pricing: FALLBACK_PRICING, known: false };
}

const USAGE_FIELDS: (keyof ModelUsage)[] = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
];

/** Fail loud on malformed usage data instead of letting it silently compute
 *  NaN/Infinity that then propagates into cost totals and reports unnoticed. */
function assertValidUsage(usage: ModelUsage): void {
  if (usage === null || typeof usage !== "object") {
    throw new Error(`Invalid usage data: expected an object, got ${JSON.stringify(usage)}`);
  }
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `Invalid usage data: "${field}" must be a finite number, got ${JSON.stringify(value)}`
      );
    }
  }
}

export function costOf(usage: ModelUsage, pricing: ModelPricing): number {
  assertValidUsage(usage);
  return (
    (usage.inputTokens * pricing.inputPerM +
      usage.outputTokens * pricing.outputPerM +
      usage.cacheReadTokens * pricing.cacheReadPerM +
      usage.cacheWriteTokens * pricing.cacheWritePerM) /
    1_000_000
  );
}

export interface CostLine {
  model: string;
  usage: ModelUsage;
  cost: number;
  known: boolean;
}

export interface CostEstimate {
  total: number;
  lines: CostLine[];
  anyUnknown: boolean;
}

export function estimateCost(usageByModel: Record<string, ModelUsage>): CostEstimate {
  const lines: CostLine[] = [];
  let total = 0;
  let anyUnknown = false;
  for (const model of Object.keys(usageByModel).sort()) {
    const { pricing, known } = priceFor(model);
    let cost: number;
    try {
      cost = costOf(usageByModel[model], pricing);
    } catch (err) {
      throw new Error(`estimateCost: invalid usage for model "${model}": ${(err as Error).message}`, { cause: err });
    }
    if (!known) anyUnknown = true;
    total += cost;
    lines.push({ model, usage: usageByModel[model], cost, known });
  }
  return { total, lines, anyUnknown };
}
