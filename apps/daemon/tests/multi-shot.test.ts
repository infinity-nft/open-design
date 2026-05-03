// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { multiShotDirective, readMultiShotFlag } from '../src/prompts/multi-shot.js';

describe('readMultiShotFlag', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OD_MULTI_SHOT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OD_MULTI_SHOT;
    else process.env.OD_MULTI_SHOT = original;
  });

  it('returns null when flag is unset', () => {
    delete process.env.OD_MULTI_SHOT;
    expect(readMultiShotFlag()).toBeNull();
  });

  it.each(['', '0', 'false', 'off', '1'])('returns null for off-equivalent value %s', (value) => {
    process.env.OD_MULTI_SHOT = value;
    expect(readMultiShotFlag()).toBeNull();
  });

  it('returns default K=3 for "true" / "on"', () => {
    process.env.OD_MULTI_SHOT = 'on';
    expect(readMultiShotFlag()).toEqual({ k: 3 });
  });

  it('parses explicit K from numeric value', () => {
    process.env.OD_MULTI_SHOT = '2';
    expect(readMultiShotFlag()).toEqual({ k: 2 });
    process.env.OD_MULTI_SHOT = '3';
    expect(readMultiShotFlag()).toEqual({ k: 3 });
  });

  it('clamps K to a sane upper bound (5)', () => {
    process.env.OD_MULTI_SHOT = '99';
    expect(readMultiShotFlag()).toEqual({ k: 5 });
  });
});

describe('multiShotDirective', () => {
  it('contains the load-bearing schema and bias-mitigation rules', () => {
    const out = multiShotDirective(3);
    // Schema fields parsed by judge-parser.
    for (const field of ['winner', 'ranking', 'rationale', 'confidence', 'axis']) {
      expect(out).toContain(field);
    }
    // Bias mitigations from 2026 LLM-as-judge research.
    expect(out).toMatch(/Pairwise, not pointwise/i);
    expect(out).toMatch(/Both orderings/i);
    expect(out).toMatch(/Position bias/i);
    expect(out).toMatch(/Verbosity bias/i);
    expect(out).toMatch(/Self-preference/i);
  });

  it('mentions the chosen K in the directive', () => {
    expect(multiShotDirective(2)).toMatch(/2 distinct variants/);
    expect(multiShotDirective(3)).toMatch(/3 distinct variants/);
  });

  it('forbids re-judging or regenerating after verdict', () => {
    const out = multiShotDirective(3);
    expect(out).toMatch(/One pass/i);
    expect(out).toMatch(/Do not re-judge/i);
  });
});

describe('composeSystemPrompt with OD_MULTI_SHOT', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OD_MULTI_SHOT;
    vi.resetModules();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OD_MULTI_SHOT;
    else process.env.OD_MULTI_SHOT = original;
    vi.resetModules();
  });

  it('omits the directive when off', async () => {
    delete process.env.OD_MULTI_SHOT;
    const fresh = await import('../src/prompts/system.js');
    const out = fresh.composeSystemPrompt({});
    expect(out).not.toContain('Multi-shot generation');
  });

  it('appends the directive when on with default K=3', async () => {
    process.env.OD_MULTI_SHOT = 'on';
    const fresh = await import('../src/prompts/system.js');
    const out = fresh.composeSystemPrompt({});
    expect(out).toContain('Multi-shot generation (3 variants this turn)');
  });

  it('skips on media surfaces — variants of an image are vendor calls, not HTML', async () => {
    process.env.OD_MULTI_SHOT = '3';
    const fresh = await import('../src/prompts/system.js');
    const html = fresh.composeSystemPrompt({ skillMode: 'prototype' });
    const image = fresh.composeSystemPrompt({ skillMode: 'image' });
    expect(html).toContain('Multi-shot generation');
    expect(image).not.toContain('Multi-shot generation');
  });
});
