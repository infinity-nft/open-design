// @ts-nocheck
/**
 * Project reference library — T2.1 storage layer.
 *
 * A "reference" is a user-curated taste signal scoped to a project.
 * The MVP supports four kinds:
 *
 *   - `design-system` → a slug under `design-systems/*` the user has
 *     starred. Cheap to store (just the id) and easy to inject into the
 *     amplified-brief context as "the user tends to like these tones".
 *   - `screenshot` → a relative path under `.od/refs/<projectId>/`,
 *     populated by an upload endpoint (T2.1b).
 *   - `url` → a source URL. The daemon may snapshot it asynchronously
 *     in T2.1b; for now we just store the URL.
 *   - `figma` → a Figma file or node identifier (handled via the
 *     Figma MCP server in T2.1c).
 *
 * Persistence: SQLite `project_references` table; see migration in
 * `db.ts`. The (project_id, kind, value) tuple is unique so star-
 * toggle is idempotent.
 *
 * The shape returned by `listProjectReferences` is the API DTO; it
 * matches the Express endpoints in `server.ts` and the contracts
 * package's `ProjectReferenceDto`.
 */

import { randomUUID } from 'node:crypto';

const ALLOWED_KINDS = new Set(['design-system', 'screenshot', 'url', 'figma']);

export function listProjectReferences(db, projectId) {
  const rows = db
    .prepare(
      `SELECT id, kind, value, label, note, created_at
       FROM project_references
       WHERE project_id = ?
       ORDER BY created_at DESC`,
    )
    .all(projectId);
  return rows.map(rowToDto);
}

export function listProjectReferencesByKind(db, projectId, kind) {
  if (!ALLOWED_KINDS.has(kind)) return [];
  const rows = db
    .prepare(
      `SELECT id, kind, value, label, note, created_at
       FROM project_references
       WHERE project_id = ? AND kind = ?
       ORDER BY created_at DESC`,
    )
    .all(projectId, kind);
  return rows.map(rowToDto);
}

/**
 * Insert (idempotent) a reference for a project. Returns the existing
 * row if (project_id, kind, value) already exists, otherwise the new
 * row. Throws on invalid kind.
 */
export function addProjectReference(db, projectId, input) {
  const kind = String(input?.kind ?? '');
  if (!ALLOWED_KINDS.has(kind)) {
    const err = new Error(`unsupported reference kind: ${kind}`);
    err.code = 'BAD_KIND';
    throw err;
  }
  const value = String(input?.value ?? '').trim();
  if (!value) {
    const err = new Error('reference value is required');
    err.code = 'BAD_VALUE';
    throw err;
  }
  if (value.length > 1024) {
    const err = new Error('reference value too long');
    err.code = 'BAD_VALUE';
    throw err;
  }
  const label = typeof input?.label === 'string' ? input.label.trim().slice(0, 200) : null;
  const note = typeof input?.note === 'string' ? input.note.trim().slice(0, 2000) : null;

  // Try insert; on UNIQUE conflict return the existing row. Using
  // ON CONFLICT preserves the original created_at so re-starring a
  // design-system does not bubble it to the top.
  const existing = db
    .prepare(
      `SELECT id, kind, value, label, note, created_at
       FROM project_references
       WHERE project_id = ? AND kind = ? AND value = ?`,
    )
    .get(projectId, kind, value);
  if (existing) return rowToDto(existing);

  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO project_references (id, project_id, kind, value, label, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, kind, value, label, note, createdAt);
  return rowToDto({ id, kind, value, label, note, created_at: createdAt });
}

/**
 * Remove a reference. Idempotent — removing a non-existent row is not
 * an error. Returns true when something was removed.
 */
export function removeProjectReference(db, projectId, refId) {
  const result = db
    .prepare(`DELETE FROM project_references WHERE id = ? AND project_id = ?`)
    .run(refId, projectId);
  return (result?.changes ?? 0) > 0;
}

/**
 * Convenience: toggle a (kind, value) pair on/off for a project. Used
 * by the star-on-design-system-card UI surface so the front end does
 * not need to track which design systems are already starred.
 *
 * Returns:
 *   { state: 'added',   ref: ProjectReferenceDto }
 *   { state: 'removed', ref: null }
 */
export function toggleProjectReference(db, projectId, input) {
  const kind = String(input?.kind ?? '');
  const value = String(input?.value ?? '').trim();
  if (!ALLOWED_KINDS.has(kind) || !value) {
    const err = new Error('toggle requires kind and value');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const existing = db
    .prepare(
      `SELECT id, kind, value, label, note, created_at
       FROM project_references
       WHERE project_id = ? AND kind = ? AND value = ?`,
    )
    .get(projectId, kind, value);
  if (existing) {
    db.prepare(`DELETE FROM project_references WHERE id = ?`).run(existing.id);
    return { state: 'removed', ref: null };
  }
  const ref = addProjectReference(db, projectId, input);
  return { state: 'added', ref };
}

function rowToDto(row) {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    label: row.label ?? null,
    note: row.note ?? null,
    createdAt: row.created_at,
  };
}
