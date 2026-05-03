/**
 * Parse `<od-critique>` blocks the agent emits in response to the
 * visual self-critique directive (`prompts/visual-critique.ts`).
 *
 * The block is JSON wrapped in an XML-style fence:
 *
 *   <od-critique schema="v1">
 *   { "verdict": "ship | revise", "reasoning": "...", "findings": [...] }
 *   </od-critique>
 *
 * This module is text-only — it does not stream-tokenise. The daemon
 * accumulates the agent's `text_delta` events into a buffer per
 * assistant turn; at end-of-turn it scans the buffer for the first
 * (and only) critique block and emits a typed `critique-result`
 * SSE event. Multiple blocks per turn are ignored after the first;
 * the agent is told to emit at most two artifacts (initial + revised)
 * with one critique per artifact, but to keep the chat surface sane
 * we surface only the LAST critique seen at end-of-turn (the verdict
 * the agent landed on).
 *
 * Robust to:
 *   - whitespace and newlines inside the block
 *   - missing schema attribute (older agent obeying older directive)
 *   - JSON wrapped in ```json fences (some models like to add fences)
 *   - extra text before / after the block
 */

export type CritiqueVerdict = 'ship' | 'revise';
export type CritiqueSeverity = 'P0' | 'P1' | 'P2';

export interface CritiqueFinding {
  severity: CritiqueSeverity;
  rule: string;
  evidence: string;
  fix: string;
}

/** 5-dimension scores from schema="v2". All values clamped to 0–10. */
export interface CritiqueScores {
  philosophy: number;
  hierarchy: number;
  detail: number;
  functionality: number;
  innovation: number;
}

export interface ParsedCritique {
  verdict: CritiqueVerdict;
  reasoning: string;
  findings: CritiqueFinding[];
  /** Present when the agent emitted schema="v2" or later. */
  scores?: CritiqueScores;
}

const CRITIQUE_BLOCK_RE = /<od-critique\b[^>]*>([\s\S]*?)<\/od-critique\s*>/gi;
const CODE_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * Find every `<od-critique>` block in the given text. Returns parsed
 * critiques in the order they appeared. Bad JSON / shape mismatches
 * are silently skipped — a malformed block is dead weight, not a
 * reason to fail the turn.
 */
export function findCritiques(text: string): ParsedCritique[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out: ParsedCritique[] = [];
  CRITIQUE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CRITIQUE_BLOCK_RE.exec(text)) !== null) {
    const inner = match[1];
    if (!inner) continue;
    const parsed = tryParseCritiqueBody(inner);
    if (parsed) out.push(parsed);
  }
  CRITIQUE_BLOCK_RE.lastIndex = 0;
  return out;
}

/**
 * Convenience: return only the last critique block in the text, which
 * is the verdict the agent settled on. Returns null when no valid
 * block is present.
 */
export function findFinalCritique(text: string): ParsedCritique | null {
  const all = findCritiques(text);
  return all.length > 0 ? all[all.length - 1]! : null;
}

/**
 * Strip critique blocks from text — used by the chat layer to keep
 * the prose pane clean while still surfacing findings via the
 * structured event. Run AFTER findCritiques (or findFinalCritique)
 * so the parsed findings are not lost.
 */
export function stripCritiques(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(CRITIQUE_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function tryParseCritiqueBody(raw: string): ParsedCritique | null {
  // Some models wrap the JSON in a ```json fence even when the surrounding
  // <od-critique> already provides a fence. Unwrap if present.
  const fenced = CODE_FENCE_RE.exec(raw);
  const candidate = fenced ? fenced[1]! : raw;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  return normaliseCritique(value);
}

function normaliseCritique(value: unknown): ParsedCritique | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const verdict = normaliseVerdict(v.verdict);
  if (!verdict) return null;
  const reasoning = typeof v.reasoning === 'string' ? v.reasoning.trim().slice(0, 400) : '';
  const findingsRaw = Array.isArray(v.findings) ? v.findings : [];
  const findings: CritiqueFinding[] = [];
  for (const item of findingsRaw) {
    const f = normaliseFinding(item);
    if (f) findings.push(f);
  }
  const scores = normaliseScores(v.scores);
  return { verdict, reasoning, findings, ...(scores ? { scores } : {}) };
}

function normaliseScores(value: unknown): CritiqueScores | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const clamp = (n: unknown): number => {
    const x = typeof n === 'number' ? n : typeof n === 'string' ? parseFloat(n) : NaN;
    return Number.isFinite(x) ? Math.max(0, Math.min(10, Math.round(x))) : 0;
  };
  // Only return scores when at least one key is present.
  if (
    v.philosophy == null &&
    v.hierarchy == null &&
    v.detail == null &&
    v.functionality == null &&
    v.innovation == null
  ) return null;
  return {
    philosophy: clamp(v.philosophy),
    hierarchy: clamp(v.hierarchy),
    detail: clamp(v.detail),
    functionality: clamp(v.functionality),
    innovation: clamp(v.innovation),
  };
}

function normaliseVerdict(value: unknown): CritiqueVerdict | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'ship' || v === 'revise') return v;
  return null;
}

function normaliseFinding(value: unknown): CritiqueFinding | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const severity = normaliseSeverity(v.severity);
  if (!severity) return null;
  // The schema asks for `rule`, `evidence`, `fix`; some models alias to
  // `id`, `snippet`, `suggestion`. Accept the aliases — defensive
  // parsing is cheap and avoids dropping correct findings on cosmetic
  // shape drift.
  const rule = pickString(v.rule, v.id, v.ruleId);
  const evidence = pickString(v.evidence, v.snippet, v.where);
  const fix = pickString(v.fix, v.suggestion, v.action);
  if (!rule && !evidence && !fix) return null;
  return {
    severity,
    rule: clip(rule, 80),
    evidence: clip(evidence, 200),
    fix: clip(fix, 240),
  };
}

function normaliseSeverity(value: unknown): CritiqueSeverity | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase();
  if (v === 'P0' || v === 'P1' || v === 'P2') return v;
  return null;
}

function pickString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return '';
}

function clip(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trimEnd() + '…';
}
