// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { deriveFeedbackSubjects } from '../src/feedback.js';

describe('deriveFeedbackSubjects', () => {
  it('uses project skill and design-system when both are present', () => {
    const out = deriveFeedbackSubjects({
      project: { skillId: 'magazine-deck', designSystemId: 'stripe' },
    });
    expect(out).toContain('skill:magazine-deck');
    expect(out).toContain('design-system:stripe');
  });

  it('falls back to overrides when the project record is missing', () => {
    const out = deriveFeedbackSubjects({
      skillIdOverride: 'docs-page',
      designSystemIdOverride: 'linear-app',
    });
    expect(out).toEqual(['skill:docs-page', 'design-system:linear-app']);
  });

  it('project values win over overrides (run-time stability)', () => {
    const out = deriveFeedbackSubjects({
      project: { skillId: 'project-skill', designSystemId: 'project-ds' },
      skillIdOverride: 'override-skill',
      designSystemIdOverride: 'override-ds',
    });
    expect(out).toContain('skill:project-skill');
    expect(out).toContain('design-system:project-ds');
    expect(out).not.toContain('skill:override-skill');
  });

  it('extracts up to 3 mood tones from project metadata', () => {
    const out = deriveFeedbackSubjects({
      project: {
        metadata: {
          tone: ['Editorial / magazine', 'Modern minimal', 'Tech / utility', 'Soft / warm'],
        },
      },
    });
    // Only the first 3 are kept; case lowered.
    const moodLines = out.filter((s) => s.startsWith('mood:'));
    expect(moodLines).toHaveLength(3);
    expect(moodLines[0]).toBe('mood:editorial / magazine');
  });

  it('returns the fallback subject when no context is available', () => {
    expect(deriveFeedbackSubjects({})).toEqual(['feedback:run']);
    expect(deriveFeedbackSubjects({ project: null })).toEqual(['feedback:run']);
  });

  it('lowercases all subject values', () => {
    const out = deriveFeedbackSubjects({
      project: { skillId: 'Magazine-DECK', designSystemId: 'STRIPE' },
    });
    expect(out).toContain('skill:magazine-deck');
    expect(out).toContain('design-system:stripe');
  });

  it('ignores non-string / empty tone entries', () => {
    const out = deriveFeedbackSubjects({
      project: {
        metadata: { tone: ['', null, 'editorial', 7] as unknown[] },
      },
    });
    const moodLines = out.filter((s) => s.startsWith('mood:'));
    expect(moodLines).toEqual(['mood:editorial']);
  });

  it('treats absent metadata gracefully', () => {
    const out = deriveFeedbackSubjects({
      project: { skillId: 'a', designSystemId: 'b' },
    });
    expect(out).toEqual(['skill:a', 'design-system:b']);
  });

  it('drops the fallback subject when ANY context entry exists', () => {
    const out = deriveFeedbackSubjects({
      project: { skillId: 'just-skill' },
    });
    expect(out).not.toContain('feedback:run');
  });
});
