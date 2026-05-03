import { describe, expect, it } from 'vitest';
import {
  findJudges,
  findFinalJudge,
  stripJudges,
} from '../src/judge-parser.js';

const SAMPLE = `
…artifacts above…

<od-judge schema="v1">
{
  "winner": "B",
  "axis": "layout",
  "ranking": ["B", "A", "C"],
  "rationale": [
    { "variant": "B", "verdict": "win", "why": "asymmetric grid lands the eye on the CTA first" },
    { "variant": "A", "verdict": "runner-up", "why": "centered hero competes with the secondary nav" },
    { "variant": "C", "verdict": "last", "why": "side-by-side splits attention and breaks rhythm" }
  ],
  "confidence": "high"
}
</od-judge>
`;

describe('findJudges', () => {
  it('parses a typical judge block', () => {
    const out = findJudges(SAMPLE);
    expect(out).toHaveLength(1);
    const j = out[0]!;
    expect(j.winner).toBe('B');
    expect(j.ranking).toEqual(['B', 'A', 'C']);
    expect(j.confidence).toBe('high');
    expect(j.rationale).toHaveLength(3);
    expect(j.rationale[0]!.verdict).toBe('win');
  });

  it('accepts variant labels with the variant- prefix the directive uses on artifacts', () => {
    const text = `<od-judge>{"winner":"variant-A","ranking":["variant-A","variant-B"],"rationale":[],"confidence":"medium"}</od-judge>`;
    const out = findJudges(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.winner).toBe('A');
    expect(out[0]!.ranking).toEqual(['A', 'B']);
  });

  it('drops a judge whose winner is not in the ranking', () => {
    const text = `<od-judge>{"winner":"D","ranking":["A","B","C"],"rationale":[],"confidence":"low"}</od-judge>`;
    expect(findJudges(text)).toEqual([]);
  });

  it('returns empty when no block is present', () => {
    expect(findJudges('hi')).toEqual([]);
    expect(findJudges('')).toEqual([]);
  });

  it('skips malformed JSON silently', () => {
    expect(findJudges('<od-judge>{not json}</od-judge>')).toEqual([]);
  });

  it('clamps unknown confidence to medium', () => {
    const text = `<od-judge>{"winner":"A","ranking":["A"],"rationale":[],"confidence":"max"}</od-judge>`;
    const out = findJudges(text);
    expect(out[0]!.confidence).toBe('medium');
  });

  it('accepts aliased verdict names (winner / second / worst)', () => {
    const text = `<od-judge>{"winner":"A","ranking":["A","B","C"],"confidence":"medium","rationale":[
      {"variant":"A","verdict":"winner","why":"x"},
      {"variant":"B","verdict":"second","why":"y"},
      {"variant":"C","verdict":"worst","why":"z"}
    ]}</od-judge>`;
    const out = findJudges(text);
    expect(out[0]!.rationale.map((r) => r.verdict)).toEqual(['win', 'runner-up', 'last']);
  });

  it('drops rationale rows whose variant is not in ranking', () => {
    const text = `<od-judge>{"winner":"A","ranking":["A","B"],"confidence":"medium","rationale":[
      {"variant":"A","verdict":"win","why":"x"},
      {"variant":"Z","verdict":"last","why":"unrelated"}
    ]}</od-judge>`;
    const out = findJudges(text);
    expect(out[0]!.rationale.map((r) => r.variant)).toEqual(['A']);
  });

  it('clips overly long why fields', () => {
    const text = `<od-judge>${JSON.stringify({
      winner: 'A',
      ranking: ['A'],
      confidence: 'medium',
      rationale: [{ variant: 'A', verdict: 'win', why: 'w'.repeat(500) }],
    })}</od-judge>`;
    const out = findJudges(text);
    expect(out[0]!.rationale[0]!.why.length).toBeLessThanOrEqual(200);
  });

  it('handles inner ```json fences', () => {
    const text = '<od-judge>\n```json\n{"winner":"A","ranking":["A"],"rationale":[],"confidence":"medium"}\n```\n</od-judge>';
    const out = findJudges(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.winner).toBe('A');
  });
});

describe('findFinalJudge', () => {
  it('returns the last block', () => {
    const text = `<od-judge>{"winner":"A","ranking":["A"],"rationale":[],"confidence":"low"}</od-judge>
<od-judge>{"winner":"B","ranking":["B"],"rationale":[],"confidence":"high"}</od-judge>`;
    expect(findFinalJudge(text)?.winner).toBe('B');
  });

  it('returns null when nothing parses', () => {
    expect(findFinalJudge('hi')).toBeNull();
  });
});

describe('stripJudges', () => {
  it('removes the block from prose', () => {
    const stripped = stripJudges(SAMPLE);
    expect(stripped).not.toContain('<od-judge');
    expect(stripped).not.toContain('winner');
  });
});
