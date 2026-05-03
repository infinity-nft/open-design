// @ts-nocheck
/**
 * Taste memory — T2.2 storage and aggregation layer.
 *
 * Each row in `taste_signals` is a single event ("the user clicked
 * Auto-revise on an artifact whose accent was #6366f1", "the agent's
 * judge picked variant B which was an asymmetric layout"). On read,
 * we aggregate by (scope, subject) and produce a signed score per
 * subject. The aggregate is a derived view — we never store it.
 *
 * Three scopes (matching Mem0's user / session / agent split, mapped
 * to OD's user / project / session contexts):
 *
 *   - **user**    durable across all projects
 *   - **project** locked to a single project_id
 *   - **session** ephemeral; tied to a session_id (per-conversation)
 *
 * Subjects are normalised strings of the form `kind:value`:
 *
 *   color:#6366f1                 — accent color seen in artifact
 *   design-system:stripe          — the active or starred system
 *   mood:editorial                — extracted from brief
 *   skill:magazine-deck           — picked skill kind
 *   layout:asymmetric             — judge axis when known
 *   typography:serif-display      — derived from accepted artifact
 *
 * Polarity is +1 (positive — the user kept this / picked this /
 * accepted this) or -1 (negative — rejected via Auto-revise, lint
 * P0, comment-mode edit). The aggregator sums polarities per subject
 * with a recency weight so old signals fade.
 *
 * Why aggregate on read, not write. (a) Avoids a derivation step or
 * cron. (b) Lets us tune the recency-weight curve without touching
 * stored data. (c) The user can edit / delete any signal and the next
 * read sees the updated aggregate.
 */

import { randomUUID } from 'node:crypto';

const ALLOWED_SCOPES = new Set(['user', 'project', 'session']);
const ALLOWED_SOURCES = new Set([
  'judge',
  'lint',
  'auto-revise',
  'comment',
  'reference',
  'feedback',
  'manual', // user adding via inspector UI (when it ships)
]);

export interface TasteSignalInput {
  scope: 'user' | 'project' | 'session';
  projectId?: string | null;
  sessionId?: string | null;
  subject: string;
  polarity: 1 | -1;
  source:
    | 'judge'
    | 'lint'
    | 'auto-revise'
    | 'comment'
    | 'reference'
    | 'feedback'
    | 'manual';
  payload?: Record<string, unknown> | null;
}

export interface TasteAggregate {
  subject: string;
  /** Sum of polarity * recency-weight, rounded to 2 decimals. */
  score: number;
  /** Number of supporting signals (regardless of polarity). */
  count: number;
  /** Number of positive signals. */
  positive: number;
  /** Number of negative signals. */
  negative: number;
  /** Confidence label per docs/prompt-engineering.md Layer 6. */
  confidence: 'high' | 'medium' | 'low';
  /** Most recent signal timestamp (epoch ms). */
  lastSignalAt: number;
}

const SUBJECT_RE = /^[a-z][a-z0-9_-]*:[\w./#:%@+=()\-,\s]{1,200}$/i;

export function recordTasteSignal(db, input: TasteSignalInput): { id: string } | null {
  if (!ALLOWED_SCOPES.has(input.scope)) return null;
  if (!ALLOWED_SOURCES.has(input.source)) return null;
  if (input.polarity !== 1 && input.polarity !== -1) return null;
  const subject = normaliseSubject(input.subject);
  if (!subject) return null;

  const projectId = input.scope === 'user' ? null : input.projectId ?? null;
  const sessionId = input.scope === 'session' ? input.sessionId ?? null : null;
  if (input.scope === 'project' && !projectId) return null;
  if (input.scope === 'session' && !sessionId) return null;

  const id = randomUUID();
  const createdAt = Date.now();
  const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
  db.prepare(
    `INSERT INTO taste_signals (id, scope, project_id, session_id, subject, polarity, source, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scope,
    projectId,
    sessionId,
    subject,
    input.polarity,
    input.source,
    payloadJson,
    createdAt,
  );
  return { id };
}

/**
 * Normalise a subject string to a canonical form. Returns null when
 * the input is malformed.
 *   - kind prefix lowercased
 *   - value trimmed
 *   - colors normalised to lowercase 6/8-char hex when possible
 */
export function normaliseSubject(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 240) return null;
  const colonAt = trimmed.indexOf(':');
  if (colonAt <= 0) return null;
  const kind = trimmed.slice(0, colonAt).toLowerCase();
  let value = trimmed.slice(colonAt + 1).trim();
  if (!value) return null;
  if (kind === 'color' || kind === 'accent') {
    value = normaliseColorValue(value);
  } else {
    value = value.toLowerCase();
  }
  const out = `${kind}:${value}`;
  if (!SUBJECT_RE.test(out)) return null;
  return out;
}

function normaliseColorValue(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  // Expand #abc → #aabbcc.
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f]?)$/.exec(trimmed);
  if (shortHex) {
    const [, r, g, b, a] = shortHex;
    return a ? `#${r}${r}${g}${g}${b}${b}${a}${a}` : `#${r}${r}${g}${g}${b}${b}`;
  }
  return trimmed;
}

interface AggregateOptions {
  /** Half-life for the recency weight, in days. Older signals fade. */
  halfLifeDays?: number;
  /** Cap how many subjects to return (top |score|). */
  limit?: number;
  /** Skip subjects whose absolute score is below this threshold. */
  minAbsScore?: number;
}

const DEFAULT_HALF_LIFE_DAYS = 30;
const DEFAULT_LIMIT = 24;
const DEFAULT_MIN_ABS_SCORE = 0.5;

/**
 * Aggregate user-level signals (across all projects). Used to produce
 * the user's durable taste profile injected into every prompt.
 */
export function aggregateUserTaste(db, opts: AggregateOptions = {}): TasteAggregate[] {
  const rows = db
    .prepare(
      `SELECT subject, polarity, created_at
       FROM taste_signals
       WHERE scope = 'user'`,
    )
    .all();
  return aggregate(rows, opts);
}

/**
 * Aggregate project-level signals. The injection layer combines user-
 * level and project-level into one block per Mem0's three-scope
 * pattern; the project layer overrides the user layer when they
 * disagree.
 */
export function aggregateProjectTaste(
  db,
  projectId: string,
  opts: AggregateOptions = {},
): TasteAggregate[] {
  if (!projectId) return [];
  const rows = db
    .prepare(
      `SELECT subject, polarity, created_at
       FROM taste_signals
       WHERE scope = 'project' AND project_id = ?`,
    )
    .all(projectId);
  return aggregate(rows, opts);
}

export function aggregateSessionTaste(
  db,
  sessionId: string,
  opts: AggregateOptions = {},
): TasteAggregate[] {
  if (!sessionId) return [];
  const rows = db
    .prepare(
      `SELECT subject, polarity, created_at
       FROM taste_signals
       WHERE scope = 'session' AND session_id = ?`,
    )
    .all(sessionId);
  return aggregate(rows, opts);
}

function aggregate(rows: { subject: string; polarity: number; created_at: number }[], opts: AggregateOptions): TasteAggregate[] {
  const halfLifeMs = (opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const minAbs = opts.minAbsScore ?? DEFAULT_MIN_ABS_SCORE;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const map = new Map<string, { score: number; count: number; positive: number; negative: number; lastSignalAt: number }>();
  for (const row of rows) {
    const ageMs = Math.max(0, now - row.created_at);
    // Half-life decay: weight = 0.5 ^ (age / halflife).
    const weight = Math.pow(0.5, ageMs / halfLifeMs);
    const existing = map.get(row.subject) ?? {
      score: 0,
      count: 0,
      positive: 0,
      negative: 0,
      lastSignalAt: 0,
    };
    existing.score += row.polarity * weight;
    existing.count += 1;
    if (row.polarity > 0) existing.positive += 1;
    else existing.negative += 1;
    if (row.created_at > existing.lastSignalAt) existing.lastSignalAt = row.created_at;
    map.set(row.subject, existing);
  }

  const out: TasteAggregate[] = [];
  for (const [subject, agg] of map) {
    if (Math.abs(agg.score) < minAbs) continue;
    out.push({
      subject,
      score: Math.round(agg.score * 100) / 100,
      count: agg.count,
      positive: agg.positive,
      negative: agg.negative,
      confidence: deriveConfidence(agg.count, agg.positive, agg.negative),
      lastSignalAt: agg.lastSignalAt,
    });
  }

  out.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  return out.slice(0, limit);
}

/**
 * Confidence labels per docs/prompt-engineering.md Layer 6:
 *   high   ≥10 supporting signals AND consistent direction
 *   medium ≥5 signals
 *   low    1–4 signals (emerging pattern)
 *
 * "Consistent direction" means the dominant polarity holds at least
 * 80% of the count — flapping signals get medium at most.
 */
function deriveConfidence(count: number, positive: number, negative: number): 'high' | 'medium' | 'low' {
  if (count >= 10) {
    const dominant = Math.max(positive, negative);
    if (dominant / count >= 0.8) return 'high';
    return 'medium';
  }
  if (count >= 5) return 'medium';
  return 'low';
}

/**
 * List raw signals for the inspector UI. Returns most-recent first.
 */
export function listTasteSignals(
  db,
  scope: 'user' | 'project' | 'session',
  scopeId: string | null,
  limit = 200,
): Array<{
  id: string;
  scope: string;
  projectId: string | null;
  sessionId: string | null;
  subject: string;
  polarity: number;
  source: string;
  createdAt: number;
}> {
  if (!ALLOWED_SCOPES.has(scope)) return [];
  let rows;
  if (scope === 'user') {
    rows = db
      .prepare(
        `SELECT id, scope, project_id, session_id, subject, polarity, source, created_at
         FROM taste_signals
         WHERE scope = 'user'
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit);
  } else if (scope === 'project') {
    if (!scopeId) return [];
    rows = db
      .prepare(
        `SELECT id, scope, project_id, session_id, subject, polarity, source, created_at
         FROM taste_signals
         WHERE scope = 'project' AND project_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(scopeId, limit);
  } else {
    if (!scopeId) return [];
    rows = db
      .prepare(
        `SELECT id, scope, project_id, session_id, subject, polarity, source, created_at
         FROM taste_signals
         WHERE scope = 'session' AND session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(scopeId, limit);
  }
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    projectId: r.project_id,
    sessionId: r.session_id,
    subject: r.subject,
    polarity: r.polarity,
    source: r.source,
    createdAt: r.created_at,
  }));
}

export function deleteTasteSignal(db, id: string): boolean {
  const result = db.prepare(`DELETE FROM taste_signals WHERE id = ?`).run(id);
  return (result?.changes ?? 0) > 0;
}

export function clearTasteScope(
  db,
  scope: 'user' | 'project' | 'session',
  scopeId: string | null = null,
): number {
  if (scope === 'user') {
    return db.prepare(`DELETE FROM taste_signals WHERE scope = 'user'`).run().changes ?? 0;
  }
  if (scope === 'project' && scopeId) {
    return (
      db.prepare(`DELETE FROM taste_signals WHERE scope = 'project' AND project_id = ?`)
        .run(scopeId).changes ?? 0
    );
  }
  if (scope === 'session' && scopeId) {
    return (
      db.prepare(`DELETE FROM taste_signals WHERE scope = 'session' AND session_id = ?`)
        .run(scopeId).changes ?? 0
    );
  }
  return 0;
}
