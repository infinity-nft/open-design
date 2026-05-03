// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { AMPLIFY_BRIEF_DIRECTIVE } from '../src/prompts/amplify-brief.js';

describe('AMPLIFY_BRIEF_DIRECTIVE', () => {
  it('contains the load-bearing schema fields', () => {
    // The schema is what downstream loops compare artifacts against; the
    // field set must stay stable. If a field is renamed, lint/critique
    // contracts must move with it.
    for (const field of [
      'summary',
      'audience',
      'mood',
      'density',
      'must_use',
      'must_avoid',
      'layout_reference',
      'success_criteria',
    ]) {
      expect(AMPLIFY_BRIEF_DIRECTIVE).toContain(field);
    }
    expect(AMPLIFY_BRIEF_DIRECTIVE).toContain('schema="v1"');
    expect(AMPLIFY_BRIEF_DIRECTIVE).toContain('<od-brief');
  });

  it('insists on measurable success criteria and concrete hazards', () => {
    // These are the rules that distinguish "good brief" from "vibes
    // brief"; if they get edited away the downstream loops degrade
    // silently. Keep the assertions as guard rails.
    expect(AMPLIFY_BRIEF_DIRECTIVE).toContain('measurable');
    expect(AMPLIFY_BRIEF_DIRECTIVE).toContain('Tokens, not adjectives');
    expect(AMPLIFY_BRIEF_DIRECTIVE).toContain('Concrete hazards, not generic risks');
    expect(AMPLIFY_BRIEF_DIRECTIVE).toContain('Echo, don\'t invent');
  });
});

describe('composeSystemPrompt with OD_BRIEF_AMPLIFY', () => {
  let originalFlag: string | undefined;
  beforeEach(() => {
    originalFlag = process.env.OD_BRIEF_AMPLIFY;
    // The flag is read at module-eval time, so each test resets the
    // module cache and re-imports after setting the env.
    vi.resetModules();
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.OD_BRIEF_AMPLIFY;
    else process.env.OD_BRIEF_AMPLIFY = originalFlag;
    vi.resetModules();
  });

  it('omits the directive when the flag is off (default)', async () => {
    delete process.env.OD_BRIEF_AMPLIFY;
    const fresh = await import('../src/prompts/system.js');
    const out = fresh.composeSystemPrompt({});
    expect(out).not.toContain('<od-brief schema="v1">');
  });

  it('includes the directive when the flag is on', async () => {
    process.env.OD_BRIEF_AMPLIFY = '1';
    const fresh = await import('../src/prompts/system.js');
    const out = fresh.composeSystemPrompt({});
    expect(out).toContain('<od-brief schema="v1">');
    expect(out).toContain('Brief amplification');
  });
});
