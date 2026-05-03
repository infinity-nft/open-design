// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../src/prompts/system.js';

describe('composeSystemPrompt — references injection', () => {
  it('omits the block when references is undefined', () => {
    const out = composeSystemPrompt({});
    expect(out).not.toContain('User-curated references');
  });

  it('omits the block when references is empty', () => {
    const out = composeSystemPrompt({ references: [] });
    expect(out).not.toContain('User-curated references');
  });

  it('renders a starred-design-systems sentence', () => {
    const out = composeSystemPrompt({
      references: [
        { kind: 'design-system', value: 'stripe' },
        { kind: 'design-system', value: 'linear-app' },
      ],
    });
    expect(out).toContain('User-curated references');
    expect(out).toContain('Starred design systems');
    expect(out).toContain('stripe, linear-app');
    // The framing must mark refs as taste signals, not constraints —
    // otherwise the agent overrides DESIGN.md with the favourite.
    expect(out).toMatch(/taste signals/i);
    expect(out).toMatch(/do \*\*not\*\* override/);
  });

  it('groups concrete references (urls / figma / screenshots) under their own section', () => {
    const out = composeSystemPrompt({
      references: [
        { kind: 'design-system', value: 'stripe' },
        { kind: 'url', value: 'https://example.com', label: 'competitor' },
        { kind: 'figma', value: 'figma.com/design/abc', label: 'moodboard' },
        { kind: 'screenshot', value: 'refs/hero.png' },
      ],
    });
    expect(out).toContain('Starred design systems');
    expect(out).toContain('Concrete references');
    expect(out).toContain('https://example.com');
    expect(out).toContain('figma.com/design/abc');
    expect(out).toContain('refs/hero.png');
    expect(out).toContain('competitor');
  });

  it('still renders concrete-only refs with no design-systems', () => {
    const out = composeSystemPrompt({
      references: [{ kind: 'url', value: 'https://x.example' }],
    });
    expect(out).not.toContain('Starred design systems');
    expect(out).toContain('Concrete references');
    expect(out).toContain('https://x.example');
  });
});
