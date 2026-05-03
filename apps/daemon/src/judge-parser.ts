/**
 * Parse `<od-judge>` blocks the agent emits in response to the
 * multi-shot directive (`prompts/multi-shot.ts`).
 *
 * Schema:
 *   <od-judge schema="v1">
 *   { "winner": "A" | "B" | "C", "axis": "...", "ranking": ["A","B","C"],
 *     "rationale": [{variant, verdict, why}, ...], "confidence": "..." }
 *   </od-judge>
 *
 * Defensive normalisation: ranking entries case-folded, variants
 * matching `[A-Z]` letter only (alpha label per directive), confidence
 * clamped to one of low/medium/high, rationale rows truncated to ≤140
 * chars per the schema. Bad shape silently drops the parse.
 */

export type JudgeVerdict = 'win' | 'runner-up' | 'last';
export type JudgeConfidence = 'high' | 'medium' | 'low';

export interface JudgeRationaleRow {
  variant: string;
  verdict: JudgeVerdict;
  why: string;
}

export interface ParsedJudge {
  winner: string;
  axis: string;
  ranking: string[];
  rationale: JudgeRationaleRow[];
  confidence: JudgeConfidence;
}

const JUDGE_BLOCK_RE = /<od-judge\b[^>]*>([\s\S]*?)<\/od-judge\s*>/gi;
const CODE_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

export function findJudges(text: string): ParsedJudge[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out: ParsedJudge[] = [];
  JUDGE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JUDGE_BLOCK_RE.exec(text)) !== null) {
    const inner = match[1];
    if (!inner) continue;
    const parsed = tryParseJudgeBody(inner);
    if (parsed) out.push(parsed);
  }
  JUDGE_BLOCK_RE.lastIndex = 0;
  return out;
}

export function findFinalJudge(text: string): ParsedJudge | null {
  const all = findJudges(text);
  return all.length > 0 ? all[all.length - 1]! : null;
}

export function stripJudges(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(JUDGE_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function tryParseJudgeBody(raw: string): ParsedJudge | null {
  const fenced = CODE_FENCE_RE.exec(raw);
  const candidate = fenced ? fenced[1]! : raw;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  return normaliseJudge(value);
}

function normaliseJudge(value: unknown): ParsedJudge | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;

  const winner = normaliseVariantLabel(v.winner);
  if (!winner) return null;

  const ranking = normaliseRanking(v.ranking);
  if (ranking.length === 0) return null;
  // Winner must be in the ranking — defends against the "winner says A,
  // ranking starts with B" shape error.
  if (!ranking.includes(winner)) return null;

  const axis = typeof v.axis === 'string' ? clip(v.axis, 30) : '';
  const confidence = normaliseConfidence(v.confidence);
  const rationale = normaliseRationale(v.rationale, ranking);

  return { winner, axis, ranking, rationale, confidence };
}

function normaliseVariantLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase();
  // Accept variant-A / variant-B too — the directive sets these as
  // artifact ids, so a model that copies the id verbatim should still
  // judge correctly.
  const stripped = v.startsWith('VARIANT-') ? v.slice('VARIANT-'.length) : v;
  if (/^[A-Z]$/.test(stripped)) return stripped;
  return null;
}

function normaliseRanking(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const label = normaliseVariantLabel(item);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

function normaliseConfidence(value: unknown): JudgeConfidence {
  if (typeof value !== 'string') return 'medium';
  const v = value.trim().toLowerCase();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return 'medium';
}

function normaliseRationale(value: unknown, ranking: string[]): JudgeRationaleRow[] {
  if (!Array.isArray(value)) return [];
  const allowedVariants = new Set(ranking);
  const out: JudgeRationaleRow[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const variant = normaliseVariantLabel(row.variant);
    if (!variant || !allowedVariants.has(variant)) continue;
    const verdict = normaliseRationaleVerdict(row.verdict);
    if (!verdict) continue;
    const why = typeof row.why === 'string' ? clip(row.why.trim(), 200) : '';
    out.push({ variant, verdict, why });
  }
  return out;
}

function normaliseRationaleVerdict(value: unknown): JudgeVerdict | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'win' || v === 'runner-up' || v === 'last') return v;
  // Accept common aliases.
  if (v === 'winner' || v === 'best') return 'win';
  if (v === 'second' || v === 'runner up') return 'runner-up';
  if (v === 'worst' || v === 'third') return 'last';
  return null;
}

function clip(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trimEnd() + '…';
}
