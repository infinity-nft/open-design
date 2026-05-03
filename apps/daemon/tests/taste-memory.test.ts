// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase, closeDatabase } from '../src/db.js';
import {
  recordTasteSignal,
  aggregateUserTaste,
  aggregateProjectTaste,
  aggregateSessionTaste,
  listTasteSignals,
  deleteTasteSignal,
  clearTasteScope,
  normaliseSubject,
} from '../src/taste-memory.js';

async function freshDb() {
  const dir = await mkdtemp(path.join(tmpdir(), 'od-taste-'));
  closeDatabase();
  const db = openDatabase(dir, { dataDir: dir });
  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('proj-1', 'Project 1', Date.now(), Date.now());
  return { db, dir };
}

describe('normaliseSubject', () => {
  it('lowercases the kind prefix and trims', () => {
    expect(normaliseSubject('  Color: #6366F1  ')).toBe('color:#6366f1');
    expect(normaliseSubject('DESIGN-SYSTEM:Stripe')).toBe('design-system:stripe');
  });

  it('expands 3-char hex to 6-char', () => {
    expect(normaliseSubject('color:#abc')).toBe('color:#aabbcc');
  });

  it('rejects malformed subjects', () => {
    expect(normaliseSubject('')).toBeNull();
    expect(normaliseSubject('no-colon')).toBeNull();
    expect(normaliseSubject(':just-value')).toBeNull();
    expect(normaliseSubject('kind:')).toBeNull();
    expect(normaliseSubject('x'.repeat(300))).toBeNull();
  });
});

describe('recordTasteSignal', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(async () => {
    const f = await freshDb();
    dir = f.dir;
    db = f.db;
  });
  afterEach(async () => {
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it('inserts a valid user-level signal', () => {
    const result = recordTasteSignal(db, {
      scope: 'user',
      subject: 'judge-axis:layout',
      polarity: 1,
      source: 'judge',
    });
    expect(result?.id).toBeDefined();
    const list = listTasteSignals(db, 'user', null);
    expect(list).toHaveLength(1);
    expect(list[0].subject).toBe('judge-axis:layout');
  });

  it('rejects unknown scope', () => {
    const out = recordTasteSignal(db, {
      scope: 'galaxy',
      subject: 'k:v',
      polarity: 1,
      source: 'judge',
    });
    expect(out).toBeNull();
  });

  it('rejects unknown source', () => {
    expect(
      recordTasteSignal(db, { scope: 'user', subject: 'k:v', polarity: 1, source: 'bogus' }),
    ).toBeNull();
  });

  it('rejects polarity that is not ±1', () => {
    expect(recordTasteSignal(db, { scope: 'user', subject: 'k:v', polarity: 0, source: 'judge' })).toBeNull();
    expect(recordTasteSignal(db, { scope: 'user', subject: 'k:v', polarity: 5, source: 'judge' })).toBeNull();
  });

  it('requires projectId for project scope', () => {
    expect(
      recordTasteSignal(db, { scope: 'project', subject: 'k:v', polarity: 1, source: 'lint' }),
    ).toBeNull();
  });

  it('requires sessionId for session scope', () => {
    expect(
      recordTasteSignal(db, { scope: 'session', subject: 'k:v', polarity: 1, source: 'lint' }),
    ).toBeNull();
  });

  it('forces projectId/sessionId nulls for non-matching scopes', () => {
    recordTasteSignal(db, {
      scope: 'user',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      subject: 'k:v',
      polarity: 1,
      source: 'judge',
    });
    const list = listTasteSignals(db, 'user', null);
    expect(list[0].projectId).toBeNull();
    expect(list[0].sessionId).toBeNull();
  });
});

describe('aggregateUserTaste', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(async () => {
    const f = await freshDb();
    dir = f.dir;
    db = f.db;
  });
  afterEach(async () => {
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it('sums polarity per subject and returns ranked aggregates', () => {
    const subj = 'judge-axis:layout';
    for (let i = 0; i < 6; i++) {
      recordTasteSignal(db, { scope: 'user', subject: subj, polarity: 1, source: 'judge' });
    }
    const out = aggregateUserTaste(db, { halfLifeDays: 365 });
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe(subj);
    expect(out[0].count).toBe(6);
    expect(out[0].positive).toBe(6);
    expect(out[0].score).toBeCloseTo(6, 1);
    expect(out[0].confidence).toBe('medium'); // ≥5 signals
  });

  it('returns "high" confidence for ≥10 consistent signals', () => {
    for (let i = 0; i < 12; i++) {
      recordTasteSignal(db, { scope: 'user', subject: 'mood:editorial', polarity: 1, source: 'judge' });
    }
    const out = aggregateUserTaste(db, { halfLifeDays: 365 });
    expect(out[0].confidence).toBe('high');
  });

  it('returns "medium" for 10+ signals when direction is mixed (<80% dominant)', () => {
    for (let i = 0; i < 7; i++) {
      recordTasteSignal(db, { scope: 'user', subject: 'mood:tech', polarity: 1, source: 'judge' });
    }
    for (let i = 0; i < 5; i++) {
      recordTasteSignal(db, { scope: 'user', subject: 'mood:tech', polarity: -1, source: 'lint' });
    }
    const out = aggregateUserTaste(db, { halfLifeDays: 365, minAbsScore: 0 });
    expect(out[0].count).toBe(12);
    expect(out[0].confidence).toBe('medium');
  });

  it('drops subjects below the absolute-score threshold', () => {
    // One isolated low-confidence signal should not pollute the profile.
    recordTasteSignal(db, { scope: 'user', subject: 'noise:thing', polarity: 1, source: 'judge' });
    const out = aggregateUserTaste(db); // default minAbsScore = 0.5
    expect(out).toEqual([]);
  });

  it('limits the result count', () => {
    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 6; j++) {
        recordTasteSignal(db, {
          scope: 'user',
          subject: `topic:topic-${i}`,
          polarity: 1,
          source: 'judge',
        });
      }
    }
    const out = aggregateUserTaste(db, { halfLifeDays: 365, limit: 5 });
    expect(out).toHaveLength(5);
  });

  it('scopes user vs project — user aggregator ignores project signals', () => {
    recordTasteSignal(db, { scope: 'user', subject: 'a:1', polarity: 1, source: 'judge' });
    for (let i = 0; i < 5; i++) {
      recordTasteSignal(db, {
        scope: 'project',
        projectId: 'proj-1',
        subject: 'b:2',
        polarity: 1,
        source: 'lint',
      });
    }
    const userOut = aggregateUserTaste(db, { minAbsScore: 0 });
    const projOut = aggregateProjectTaste(db, 'proj-1', { minAbsScore: 0 });
    expect(userOut.map((r) => r.subject)).toEqual(['a:1']);
    expect(projOut.map((r) => r.subject)).toEqual(['b:2']);
  });
});

describe('inspector helpers', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(async () => {
    const f = await freshDb();
    dir = f.dir;
    db = f.db;
  });
  afterEach(async () => {
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it('listTasteSignals returns most-recent first', () => {
    recordTasteSignal(db, { scope: 'user', subject: 'a:1', polarity: 1, source: 'judge' });
    const t1 = Date.now();
    while (Date.now() === t1) {}
    recordTasteSignal(db, { scope: 'user', subject: 'b:2', polarity: 1, source: 'judge' });
    const list = listTasteSignals(db, 'user', null);
    expect(list[0].subject).toBe('b:2');
    expect(list[1].subject).toBe('a:1');
  });

  it('deleteTasteSignal is idempotent', () => {
    const r = recordTasteSignal(db, { scope: 'user', subject: 'a:1', polarity: 1, source: 'judge' });
    expect(deleteTasteSignal(db, r.id)).toBe(true);
    expect(deleteTasteSignal(db, r.id)).toBe(false);
  });

  it('clearTasteScope wipes the requested scope only', () => {
    recordTasteSignal(db, { scope: 'user', subject: 'a:1', polarity: 1, source: 'judge' });
    recordTasteSignal(db, {
      scope: 'project',
      projectId: 'proj-1',
      subject: 'b:2',
      polarity: 1,
      source: 'lint',
    });
    clearTasteScope(db, 'user');
    expect(listTasteSignals(db, 'user', null)).toEqual([]);
    expect(listTasteSignals(db, 'project', 'proj-1')).toHaveLength(1);
  });

  it('aggregateSessionTaste scopes by session id', () => {
    recordTasteSignal(db, {
      scope: 'session',
      sessionId: 'sess-A',
      subject: 'a:1',
      polarity: 1,
      source: 'judge',
    });
    for (let i = 0; i < 5; i++) {
      recordTasteSignal(db, {
        scope: 'session',
        sessionId: 'sess-A',
        subject: 'a:1',
        polarity: 1,
        source: 'judge',
      });
    }
    expect(aggregateSessionTaste(db, 'sess-A', { minAbsScore: 0 })).toHaveLength(1);
    expect(aggregateSessionTaste(db, 'sess-B')).toEqual([]);
  });
});
