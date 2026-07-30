import type { Message } from "./agent.js";

// Context accounting behind /context and the auto-compact trigger. Everything
// here is pure and deterministic: token figures are either the API's own usage
// numbers passed in as `measuredTokens` (authoritative) or a ~4-chars/token
// character heuristic (an estimate, and always labelled as one by the caller).
// No tokenizer dependency, no network — the same testing posture as pricing.ts.

/** Heuristic: roughly 4 characters per token for English text and code. */
const CHARS_PER_TOKEN = 4;

/** Flat per-message overhead (role/structure framing) added to each message. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

export interface ContextWindowInfo {
  tokens: number;
  known: boolean;
}

// Context windows by model family, matched the same way pricing.ts matches
// price families so the numbers stay right across exact model-id revisions.
// Order matters: the 1M-window generation is matched before the older 200K one.
const FAMILY_WINDOWS: { match: RegExp; tokens: number }[] = [
  // The 1M-token-window generation: Sonnet 4.6+, Opus 4.6/4.7/4.8, and the 5-series.
  { match: /sonnet-4-6|sonnet-5|opus-4-[678]|opus-5|fable-5|mythos-5/i, tokens: 1_000_000 },
  // Haiku and older Sonnet/Opus revisions run a 200K window.
  { match: /haiku|sonnet|opus/i, tokens: 200_000 },
];

// Conservative fallback for unrecognised models (flagged, like pricing does).
const FALLBACK_WINDOW = 200_000;

export function contextWindowFor(model: string): ContextWindowInfo {
  for (const entry of FAMILY_WINDOWS) {
    if (entry.match.test(model)) return { tokens: entry.tokens, known: true };
  }
  return { tokens: FALLBACK_WINDOW, known: false };
}

/** Estimate tokens for a plain string (ceil of chars/4; 0 for empty). */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Tokens for one content block, defensively: blocks come from the SDK union or
// from saved sessions, so unknown shapes must degrade to a JSON-size estimate
// rather than throw.
function estimateBlockTokens(block: unknown): number {
  if (typeof block === "string") return estimateTextTokens(block);
  if (block === null || typeof block !== "object") {
    return estimateTextTokens(String(block ?? ""));
  }
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return estimateTextTokens(typeof b.text === "string" ? b.text : "");
    case "tool_use": {
      const name = typeof b.name === "string" ? b.name : "";
      let inputJson: string;
      try {
        inputJson = JSON.stringify(b.input) ?? "";
      } catch {
        inputJson = "";
      }
      return estimateTextTokens(name + inputJson);
    }
    case "tool_result": {
      const content = b.content;
      if (typeof content === "string") return estimateTextTokens(content);
      if (Array.isArray(content)) {
        return content.reduce<number>((sum, inner) => sum + estimateBlockTokens(inner), 0);
      }
      return 0;
    }
    default: {
      try {
        return estimateTextTokens(JSON.stringify(block) ?? "");
      } catch {
        return 0;
      }
    }
  }
}

/** Estimate tokens for a message history (content plus per-message overhead). */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;
    const content: unknown = msg.content;
    if (typeof content === "string") {
      total += estimateTextTokens(content);
    } else if (Array.isArray(content)) {
      for (const block of content) total += estimateBlockTokens(block);
    }
  }
  return total;
}

export interface ContextAnalysisOptions {
  model: string;
  /** The session's max_tokens — reserved for output, so subtracted from the window. */
  maxTokens: number;
  /** The exact system text sent on every request (base prompt + project memory). */
  systemText: string;
  /** The tool definitions sent on every request (estimated via their JSON). */
  tools: readonly unknown[];
  messages: Message[];
  /** Total tokens of the most recent API call (input + cache read + cache write
   *  + output) when a turn has run; null/omitted when nothing was sent yet. */
  measuredTokens?: number | null;
  /** Fraction of the usable window that triggers auto-compact; 0 disables. */
  autoCompactThreshold: number;
}

export interface ContextBreakdown {
  model: string;
  contextWindow: number;
  windowKnown: boolean;
  /** contextWindow minus the maxTokens output reservation, floored at 1. */
  usableWindow: number;
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
  messageCount: number;
  /** systemTokens + toolTokens + messageTokens (all heuristic estimates). */
  estimatedTotal: number;
  /** The API-reported figure passed in, or null before the first turn. */
  measuredTokens: number | null;
  /** measuredTokens when available (authoritative), else estimatedTotal. */
  effectiveTokens: number;
  /** effectiveTokens / usableWindow — may exceed 1, never negative. */
  usedFraction: number;
  autoCompactThreshold: number;
  /** Token level at which auto-compact fires; null when disabled. */
  autoCompactAt: number | null;
  willAutoCompact: boolean;
}

/** Break down context usage and decide whether auto-compact should fire. */
export function analyzeContext(opts: ContextAnalysisOptions): ContextBreakdown {
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) {
    throw new Error(`analyzeContext: maxTokens must be a positive number, got ${String(opts.maxTokens)}`);
  }
  const threshold = opts.autoCompactThreshold;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold >= 1) {
    throw new Error(
      `analyzeContext: autoCompactThreshold must be >= 0 and < 1 (0 disables), got ${String(threshold)}`,
    );
  }
  const measured = opts.measuredTokens ?? null;
  if (measured !== null && (!Number.isFinite(measured) || measured < 0)) {
    throw new Error(`analyzeContext: measuredTokens must be a non-negative number, got ${String(measured)}`);
  }

  const window = contextWindowFor(opts.model);
  const usableWindow = Math.max(window.tokens - opts.maxTokens, 1);

  const systemTokens = estimateTextTokens(opts.systemText);
  const toolTokens = opts.tools.length === 0 ? 0 : estimateTextTokens(JSON.stringify(opts.tools) ?? "");
  const messageTokens = estimateMessagesTokens(opts.messages);
  const estimatedTotal = systemTokens + toolTokens + messageTokens;

  const effectiveTokens = measured ?? estimatedTotal;
  const usedFraction = effectiveTokens / usableWindow;

  const autoCompactAt = threshold === 0 ? null : Math.floor(usableWindow * threshold);
  const willAutoCompact = autoCompactAt !== null && effectiveTokens >= autoCompactAt;

  return {
    model: opts.model,
    contextWindow: window.tokens,
    windowKnown: window.known,
    usableWindow,
    systemTokens,
    toolTokens,
    messageTokens,
    messageCount: opts.messages.length,
    estimatedTotal,
    measuredTokens: measured,
    effectiveTokens,
    usedFraction,
    autoCompactThreshold: threshold,
    autoCompactAt,
    willAutoCompact,
  };
}

/** Render a fixed-width usage bar: the bar clamps to full, the percentage does
 *  not — an overfull context honestly reads e.g. "[##########] 150%". */
export function renderContextMeter(fraction: number, width = 20): string {
  const safe = Number.isFinite(fraction) ? Math.max(fraction, 0) : 0;
  const filled = Math.min(Math.round(safe * width), width);
  const bar = "#".repeat(filled) + "-".repeat(width - filled);
  return `[${bar}] ${Math.round(safe * 100)}%`;
}
