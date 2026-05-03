// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { VISUAL_CRITIQUE_DIRECTIVE } from '../src/prompts/visual-critique.js';

describe('VISUAL_CRITIQUE_DIRECTIVE', () => {
  it('contains the load-bearing schema fields', () => {
    // The chat layer parses these field names; if a rename slips
    // through, the parser silently produces no findings. Lock the
    // contract here.
    expect(VISUAL_CRITIQUE_DIRECTIVE).toContain('<od-critique');
    expect(VISUAL_CRITIQUE_DIRECTIVE).toContain('schema="v1"');
    for (const field of ['verdict', 'reasoning', 'findings', 'severity', 'rule', 'evidence', 'fix']) {
      expect(VISUAL_CRITIQUE_DIRECTIVE).toContain(field);
    }
  });

  it('caps revision at one pass per turn (anti-elevator-music)', () => {
    // The Cell Patterns 2025 finding on closed-loop convergence is the
    // load-bearing reason for the cap; the directive must enforce it.
    expect(VISUAL_CRITIQUE_DIRECTIVE).toMatch(/one pass per turn/i);
    expect(VISUAL_CRITIQUE_DIRECTIVE).toMatch(/two artifact emits.*cap|cap.*two artifact/i);
  });

  it('forbids duplicating the deterministic linter', () => {
    // The directive must steer the agent toward findings the regex
    // linter cannot detect (structure, copy specificity, brief
    // alignment) — otherwise we burn tokens re-emitting the lint.
    expect(VISUAL_CRITIQUE_DIRECTIVE).toMatch(/Do not duplicate the linter/i);
  });

  it('forbids inventing findings to look thorough', () => {
    expect(VISUAL_CRITIQUE_DIRECTIVE).toMatch(/Empty findings is allowed/i);
    expect(VISUAL_CRITIQUE_DIRECTIVE).toMatch(/do not invent findings/i);
  });
});

describe('composeSystemPrompt with OD_VISUAL_CRITIQUE', () => {
  let originalFlag: string | undefined;
  beforeEach(() => {
    originalFlag = process.env.OD_VISUAL_CRITIQUE;
    vi.resetModules();
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.OD_VISUAL_CRITIQUE;
    else process.env.OD_VISUAL_CRITIQUE = originalFlag;
    vi.resetModules();
  });

  it('omits the directive when the flag is off (default)', async () => {
    delete process.env.OD_VISUAL_CRITIQUE;
    const fresh = await import('../src/prompts/system.js');
    const out = fresh.composeSystemPrompt({});
    expect(out).not.toContain('<od-critique schema="v1">');
  });

  it('appends the directive when the flag is on', async () => {
    process.env.OD_VISUAL_CRITIQUE = '1';
    const fresh = await import('../src/prompts/system.js');
    const out = fresh.composeSystemPrompt({});
    expect(out).toContain('<od-critique schema="v1">');
    expect(out).toContain('Visual self-critique');
  });

  it('skips the directive on media surfaces (image/video/audio)', async () => {
    process.env.OD_VISUAL_CRITIQUE = '1';
    const fresh = await import('../src/prompts/system.js');
    const html = fresh.composeSystemPrompt({ skillMode: 'prototype' });
    const image = fresh.composeSystemPrompt({ skillMode: 'image' });
    const video = fresh.composeSystemPrompt({ skillMode: 'video' });
    expect(html).toContain('<od-critique schema="v1">');
    expect(image).not.toContain('<od-critique schema="v1">');
    expect(video).not.toContain('<od-critique schema="v1">');
  });
});
