import { describe, expect, it } from 'vitest';
import {
  findCritiques,
  findFinalCritique,
  stripCritiques,
} from '../src/critique-parser.js';

const SAMPLE = `
Here is the artifact.

<od-critique schema="v1">
{
  "verdict": "revise",
  "reasoning": "accent overuse and weak hierarchy in the hero",
  "findings": [
    {
      "severity": "P0",
      "rule": "ai-default-indigo",
      "evidence": ".cta { background: #6366f1 }",
      "fix": "use var(--accent) from DESIGN.md"
    },
    {
      "severity": "P1",
      "rule": "accent-overuse",
      "evidence": "var(--accent) appears 8 times in body",
      "fix": "cap at 2 visible uses per screen"
    }
  ]
}
</od-critique>
`;

describe('findCritiques', () => {
  it('parses a typical critique block', () => {
    const out = findCritiques(SAMPLE);
    expect(out).toHaveLength(1);
    expect(out[0]!.verdict).toBe('revise');
    expect(out[0]!.findings).toHaveLength(2);
    expect(out[0]!.findings[0]!.severity).toBe('P0');
    expect(out[0]!.findings[0]!.rule).toBe('ai-default-indigo');
  });

  it('parses multiple critique blocks in order', () => {
    const text = `${SAMPLE}\n\nrevised artifact below\n\n<od-critique>{"verdict":"ship","findings":[]}</od-critique>`;
    const out = findCritiques(text);
    expect(out).toHaveLength(2);
    expect(out[0]!.verdict).toBe('revise');
    expect(out[1]!.verdict).toBe('ship');
  });

  it('returns empty when no block is present', () => {
    expect(findCritiques('just some prose')).toEqual([]);
    expect(findCritiques('')).toEqual([]);
  });

  it('skips malformed JSON silently', () => {
    const text = `<od-critique>{ this is not json }</od-critique>`;
    expect(findCritiques(text)).toEqual([]);
  });

  it('rejects critiques missing a valid verdict', () => {
    const text = `<od-critique>{"verdict":"maybe","findings":[]}</od-critique>`;
    expect(findCritiques(text)).toEqual([]);
  });

  it('handles inner ```json fences some models add', () => {
    const text =
      '<od-critique>\n```json\n{"verdict":"ship","findings":[]}\n```\n</od-critique>';
    const out = findCritiques(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.verdict).toBe('ship');
  });

  it('clips overly long fields and accepts aliased keys', () => {
    const text = `<od-critique>${JSON.stringify({
      verdict: 'revise',
      reasoning: 'r'.repeat(1000),
      findings: [
        {
          severity: 'p0',
          // Aliased keys: id/snippet/suggestion instead of rule/evidence/fix.
          id: 'rule-name',
          snippet: 'e'.repeat(500),
          suggestion: 'f'.repeat(500),
        },
      ],
    })}</od-critique>`;
    const out = findCritiques(text);
    expect(out).toHaveLength(1);
    const f = out[0]!.findings[0]!;
    expect(f.severity).toBe('P0');
    expect(f.rule).toBe('rule-name');
    expect(f.evidence.length).toBeLessThanOrEqual(200);
    expect(f.fix.length).toBeLessThanOrEqual(240);
    expect(out[0]!.reasoning.length).toBeLessThanOrEqual(400);
  });

  it('drops findings missing every field', () => {
    const text = `<od-critique>{"verdict":"ship","findings":[{},{"severity":"P0"}]}</od-critique>`;
    const out = findCritiques(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.findings).toEqual([]);
  });
});

describe('findFinalCritique', () => {
  it('returns the last block when multiple are present', () => {
    const text = `<od-critique>{"verdict":"revise","findings":[]}</od-critique>
later text
<od-critique>{"verdict":"ship","findings":[]}</od-critique>`;
    const final = findFinalCritique(text);
    expect(final?.verdict).toBe('ship');
  });

  it('returns null when nothing parses', () => {
    expect(findFinalCritique('hi')).toBeNull();
  });
});

describe('stripCritiques', () => {
  it('removes the block from prose for clean rendering', () => {
    const stripped = stripCritiques(SAMPLE);
    expect(stripped).toContain('Here is the artifact.');
    expect(stripped).not.toContain('<od-critique');
    expect(stripped).not.toContain('</od-critique>');
    expect(stripped).not.toContain('verdict');
  });

  it('collapses runs of blank lines after stripping', () => {
    const text = 'a\n\n<od-critique>{}</od-critique>\n\n\n\nb';
    const out = stripCritiques(text);
    // Three+ blank lines collapse to two.
    expect(out).not.toMatch(/\n{3,}/);
  });
});
