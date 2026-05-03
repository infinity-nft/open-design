// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase, closeDatabase } from '../src/db.js';
import {
  addProjectReference,
  listProjectReferences,
  listProjectReferencesByKind,
  removeProjectReference,
  toggleProjectReference,
} from '../src/project-references.js';

const PROJECT_ID = 'test-proj';

async function freshDb() {
  const dir = await mkdtemp(path.join(tmpdir(), 'od-refs-'));
  closeDatabase();
  const db = openDatabase(dir, { dataDir: dir });
  // Seed a project so foreign-key constraints pass.
  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(PROJECT_ID, 'Test Project', Date.now(), Date.now());
  return { db, dir };
}

describe('project-references storage', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    const fresh = await freshDb();
    dir = fresh.dir;
    db = fresh.db;
  });
  afterEach(async () => {
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a design-system favourite', () => {
    const ref = addProjectReference(db, PROJECT_ID, {
      kind: 'design-system',
      value: 'stripe',
      label: 'Stripe',
    });
    expect(ref.kind).toBe('design-system');
    expect(ref.value).toBe('stripe');
    expect(ref.label).toBe('Stripe');

    const list = listProjectReferences(db, PROJECT_ID);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(ref.id);
  });

  it('is idempotent on (kind, value) — re-adding returns the existing row', () => {
    const a = addProjectReference(db, PROJECT_ID, {
      kind: 'design-system',
      value: 'linear-app',
    });
    const b = addProjectReference(db, PROJECT_ID, {
      kind: 'design-system',
      value: 'linear-app',
    });
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(a.createdAt);
    expect(listProjectReferences(db, PROJECT_ID)).toHaveLength(1);
  });

  it('rejects invalid kinds with BAD_KIND', () => {
    expect(() =>
      addProjectReference(db, PROJECT_ID, { kind: 'bogus', value: 'x' }),
    ).toThrow(/unsupported reference kind/);
  });

  it('rejects empty value with BAD_VALUE', () => {
    expect(() =>
      addProjectReference(db, PROJECT_ID, { kind: 'design-system', value: '   ' }),
    ).toThrow(/value is required/);
  });

  it('rejects oversized values', () => {
    const huge = 'x'.repeat(2000);
    expect(() =>
      addProjectReference(db, PROJECT_ID, { kind: 'url', value: huge }),
    ).toThrow(/value too long/);
  });

  it('toggle adds when missing and removes when present', () => {
    const r1 = toggleProjectReference(db, PROJECT_ID, {
      kind: 'design-system',
      value: 'vercel',
    });
    expect(r1.state).toBe('added');
    expect(r1.ref?.value).toBe('vercel');

    const r2 = toggleProjectReference(db, PROJECT_ID, {
      kind: 'design-system',
      value: 'vercel',
    });
    expect(r2.state).toBe('removed');
    expect(listProjectReferences(db, PROJECT_ID)).toHaveLength(0);
  });

  it('listProjectReferencesByKind filters by kind', () => {
    addProjectReference(db, PROJECT_ID, { kind: 'design-system', value: 'a' });
    addProjectReference(db, PROJECT_ID, { kind: 'url', value: 'https://example.com' });
    addProjectReference(db, PROJECT_ID, { kind: 'design-system', value: 'b' });

    const ds = listProjectReferencesByKind(db, PROJECT_ID, 'design-system');
    expect(ds.map((r) => r.value).sort()).toEqual(['a', 'b']);

    const urls = listProjectReferencesByKind(db, PROJECT_ID, 'url');
    expect(urls).toHaveLength(1);
  });

  it('removeProjectReference is idempotent', () => {
    const ref = addProjectReference(db, PROJECT_ID, {
      kind: 'design-system',
      value: 'stripe',
    });
    expect(removeProjectReference(db, PROJECT_ID, ref.id)).toBe(true);
    expect(removeProjectReference(db, PROJECT_ID, ref.id)).toBe(false);
    expect(listProjectReferences(db, PROJECT_ID)).toHaveLength(0);
  });

  it('removeProjectReference scoped to project (does not delete other projects refs)', () => {
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('other-proj', 'Other', Date.now(), Date.now());
    const ours = addProjectReference(db, PROJECT_ID, { kind: 'design-system', value: 'a' });
    addProjectReference(db, 'other-proj', { kind: 'design-system', value: 'a' });

    // Cross-project remove must not delete the other project's row.
    const removed = removeProjectReference(db, 'other-proj', ours.id);
    expect(removed).toBe(false);
    expect(listProjectReferences(db, PROJECT_ID)).toHaveLength(1);
  });

  it('orders results by created_at desc', () => {
    addProjectReference(db, PROJECT_ID, { kind: 'design-system', value: 'first' });
    // Sleep a tick so created_at differs even on millisecond clocks.
    const t1 = Date.now();
    while (Date.now() === t1) {
      /* spin */
    }
    addProjectReference(db, PROJECT_ID, { kind: 'design-system', value: 'second' });
    const list = listProjectReferences(db, PROJECT_ID);
    expect(list[0]!.value).toBe('second');
    expect(list[1]!.value).toBe('first');
  });
});
