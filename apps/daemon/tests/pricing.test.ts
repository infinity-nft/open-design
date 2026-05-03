import { describe, expect, it } from 'vitest';
import { computeCostUsd, findPricing } from '../src/pricing.js';

describe('findPricing', () => {
  it('finds canonical model ids', () => {
    expect(findPricing('claude-sonnet-4-5')).not.toBeNull();
    expect(findPricing('gpt-5')).not.toBeNull();
    expect(findPricing('gemini-2.5-flash')).not.toBeNull();
  });

  it('strips trailing date suffix that vendor CLIs append', () => {
    // Anthropic's API returns model ids like "claude-sonnet-4-5-20251001";
    // we must price them as the base model.
    const pricing = findPricing('claude-sonnet-4-5-20251001');
    expect(pricing).not.toBeNull();
    expect(pricing).toEqual(findPricing('claude-sonnet-4-5'));
  });

  it('matches by prefix when the suffix is unrecognised but the base id is registered', () => {
    expect(findPricing('claude-haiku-4-5-experimental')).not.toBeNull();
  });

  it('returns null for entirely unknown model ids', () => {
    expect(findPricing('unknown-model-xyz')).toBeNull();
    expect(findPricing('')).toBeNull();
    expect(findPricing(null)).toBeNull();
    expect(findPricing(undefined)).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(findPricing('GPT-5')).toEqual(findPricing('gpt-5'));
    expect(findPricing('  Claude-Sonnet-4-5  ')).toEqual(findPricing('claude-sonnet-4-5'));
  });
});

describe('computeCostUsd', () => {
  it('computes Sonnet 4.5 cost for a typical turn', () => {
    // 1M in @ $3 + 100k out @ $15 = $3 + $1.50 = $4.50
    const cost = computeCostUsd('claude-sonnet-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });
    expect(cost).toBeCloseTo(4.5, 6);
  });

  it('adds cache-read and cache-write components when supported', () => {
    // 1M input @ $3 + 1M cache-read @ $0.30 + 1M cache-write @ $3.75 = $7.05
    const cost = computeCostUsd('claude-sonnet-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(7.05, 6);
  });

  it('ignores cache token counts for models without cache pricing', () => {
    // GPT-5 does not have separate cache pricing here, so cache counts
    // are dropped instead of inflating the bill with the wrong rate.
    const cost = computeCostUsd('gpt-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    // 1M @ $5 = $5
    expect(cost).toBeCloseTo(5, 6);
  });

  it('returns null when model is unknown', () => {
    expect(computeCostUsd('unknown-model', { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(computeCostUsd(null, { inputTokens: 1 })).toBeNull();
  });

  it('returns null when token counts are all zero or missing', () => {
    expect(computeCostUsd('claude-sonnet-4-5', {})).toBeNull();
    expect(computeCostUsd('claude-sonnet-4-5', { inputTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it('treats negative or non-finite token counts as zero', () => {
    const cost = computeCostUsd('claude-sonnet-4-5', {
      inputTokens: -100,
      outputTokens: Number.POSITIVE_INFINITY,
    });
    expect(cost).toBeNull();
  });

  it('rounds to 6 decimal places (sub-cent precision)', () => {
    // 1 token in is below micro-dollar; the rounder must keep at least
    // 6 decimals so chains of cheap turns aggregate without losing
    // information.
    const cost = computeCostUsd('claude-haiku-4-5', {
      inputTokens: 1,
      outputTokens: 1,
    });
    // 1 / 1M * $1 + 1 / 1M * $5 = 0.000006
    expect(cost).toBeCloseTo(0.000006, 9);
  });
});
