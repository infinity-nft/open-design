// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../src/prompts/system.js';

describe('composeSystemPrompt — taste injection', () => {
  it('omits the block when all three scopes are empty', () => {
    const out = composeSystemPrompt({});
    expect(out).not.toContain('Learned user preferences');
  });

  it('renders the Layer 6 "may be wrong" framing', () => {
    const out = composeSystemPrompt({
      tasteUserLevel: [
        { subject: 'mood:editorial', score: 4.2, count: 8, confidence: 'medium' },
      ],
    });
    expect(out).toContain('Learned user preferences');
    // Load-bearing phrases that prevent the model from treating the
    // profile as a hard constraint. If these get edited away the model
    // ignores explicit briefs that contradict the profile.
    expect(out).toMatch(/may be wrong/i);
    expect(out).toMatch(/probabilistic/i);
    expect(out).toMatch(/brief wins/i);
  });

  it('formats positive subjects with "prefer" and negative with "avoid"', () => {
    const out = composeSystemPrompt({
      tasteUserLevel: [
        { subject: 'mood:editorial', score: 5.0, count: 7, confidence: 'medium' },
        { subject: 'slop-rule:ai-default-indigo', score: -3.8, count: 6, confidence: 'medium' },
      ],
    });
    expect(out).toMatch(/prefer `mood:editorial`/);
    expect(out).toMatch(/avoid `slop-rule:ai-default-indigo`/);
  });

  it('layers user / project / session sections in order', () => {
    const out = composeSystemPrompt({
      tasteUserLevel: [{ subject: 'a:1', score: 5, count: 5, confidence: 'medium' }],
      tasteProjectLevel: [{ subject: 'b:2', score: 5, count: 5, confidence: 'medium' }],
      tasteSessionLevel: [{ subject: 'c:3', score: 5, count: 5, confidence: 'medium' }],
    });
    const userIdx = out.indexOf('User-level');
    const projIdx = out.indexOf('Project-level');
    const sessIdx = out.indexOf('Session-level');
    expect(userIdx).toBeGreaterThan(-1);
    expect(projIdx).toBeGreaterThan(userIdx);
    expect(sessIdx).toBeGreaterThan(projIdx);
    // All three sections include their subject lines.
    expect(out).toContain('a:1');
    expect(out).toContain('b:2');
    expect(out).toContain('c:3');
  });

  it('explains scope layering precedence to the agent', () => {
    const out = composeSystemPrompt({
      tasteUserLevel: [{ subject: 'a:1', score: 5, count: 5, confidence: 'medium' }],
    });
    // Without this guidance the model treats all three scopes as
    // equally weighted and ignores the temporal hierarchy.
    expect(out).toMatch(/project-level entries override user-level/i);
    expect(out).toMatch(/session-level entries override both/i);
  });

  it('renders confidence labels and counts so the agent can weight by certainty', () => {
    const out = composeSystemPrompt({
      tasteUserLevel: [
        { subject: 'mood:editorial', score: 8, count: 12, confidence: 'high' },
      ],
    });
    expect(out).toContain('confidence: high');
    expect(out).toContain('12 signals');
  });
});
