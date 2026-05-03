/**
 * Token-based pricing for the models OD's agents can be configured to
 * use. Returns USD cost per request when given input + output token
 * counts.
 *
 * Why this lives here. Claude Code already computes total_cost_usd in
 * its result event; we forward that verbatim. Other agents (Copilot,
 * Codex, Gemini CLI, OpenCode) emit token counts only — no cost. To
 * give the user one unified cost badge across every agent we compute
 * the dollars locally from the token counts. This is the same approach
 * Langfuse / Helicone / OpenLLMetry take for cost normalisation.
 *
 * Pricing accuracy. Prices change. Treat the numbers below as a
 * "good enough" snapshot; an agent that disagrees with a vendor invoice
 * by ≤5% is acceptable for a UX badge. When in doubt prefer the
 * agent-reported costUsd.
 *
 * Source: vendor pricing pages as of 2026-05. Prices are USD per
 * 1 million tokens, separate input vs. output.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cache-read tokens, when the model supports prompt caching. */
  cacheReadPerMTok?: number;
  /** USD per 1M cache-write tokens. */
  cacheWritePerMTok?: number;
}

// Keys are normalised model ids (lowercase, no spaces). Lookups go
// through `findPricing()` which also handles aliases (e.g. partial
// version suffixes from the agent CLIs).
const PRICING: Record<string, ModelPricing> = {
  // --- Anthropic Claude (input / output / cache-read / cache-write) -----
  'claude-opus-4-7': { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  'claude-opus-4-6': { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  'claude-opus-4-5': { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  // --- OpenAI ----------------------------------------------------------
  'gpt-5': { inputPerMTok: 5, outputPerMTok: 15 },
  'gpt-5-mini': { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'o1': { inputPerMTok: 15, outputPerMTok: 60 },
  'o1-mini': { inputPerMTok: 3, outputPerMTok: 12 },
  // --- Google Gemini ---------------------------------------------------
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'gemini-2.0-flash': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  // --- Mistral ---------------------------------------------------------
  'mistral-large': { inputPerMTok: 2, outputPerMTok: 6 },
  'mistral-small': { inputPerMTok: 0.2, outputPerMTok: 0.6 },
  // --- DeepSeek --------------------------------------------------------
  'deepseek-v3': { inputPerMTok: 0.27, outputPerMTok: 1.1 },
  'deepseek-r1': { inputPerMTok: 0.55, outputPerMTok: 2.19 },
};

function normalize(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * Look up pricing for a model id. Supports the canonical id directly,
 * plus loose suffix matching for the dated versions vendors append
 * (e.g. `claude-sonnet-4-5-20251001` → `claude-sonnet-4-5`).
 */
export function findPricing(modelId: string | null | undefined): ModelPricing | null {
  if (!modelId) return null;
  const id = normalize(modelId);
  if (PRICING[id]) return PRICING[id]!;
  // Strip a trailing date suffix like `-20251001` or `-2025-10-01`.
  const trimmed = id.replace(/-\d{4}-?\d{0,2}-?\d{0,2}$/, '');
  if (trimmed !== id && PRICING[trimmed]) return PRICING[trimmed]!;
  // Walk shortening suffixes (`-20251001` → no change since we already
  // tried; this catches cases where the alias is a prefix).
  for (const key of Object.keys(PRICING)) {
    if (id.startsWith(key)) return PRICING[key]!;
  }
  return null;
}

export interface UsageInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

/**
 * Compute USD cost for a single agent turn. Returns null when the model
 * is unknown or token counts are missing — never throws. Cache-read and
 * cache-write components are added when the model supports them and
 * the agent supplied counts.
 */
export function computeCostUsd(
  modelId: string | null | undefined,
  usage: UsageInput,
): number | null {
  const price = findPricing(modelId);
  if (!price) return null;
  const inTok = nonNegInt(usage.inputTokens);
  const outTok = nonNegInt(usage.outputTokens);
  if (inTok === 0 && outTok === 0) return null;
  const cacheReadTok = price.cacheReadPerMTok ? nonNegInt(usage.cacheReadTokens) : 0;
  const cacheWriteTok = price.cacheWritePerMTok ? nonNegInt(usage.cacheWriteTokens) : 0;
  const usd =
    (inTok * price.inputPerMTok) / 1_000_000 +
    (outTok * price.outputPerMTok) / 1_000_000 +
    (cacheReadTok * (price.cacheReadPerMTok ?? 0)) / 1_000_000 +
    (cacheWriteTok * (price.cacheWritePerMTok ?? 0)) / 1_000_000;
  // Round to 6 decimal places — sub-cent precision is meaningful for
  // chained-tool turns where individual calls cost < $0.01.
  return Math.round(usd * 1_000_000) / 1_000_000;
}

function nonNegInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}
