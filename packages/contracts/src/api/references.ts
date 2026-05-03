/**
 * Project reference library — API DTOs (T2.1).
 *
 * Endpoints (all scoped to a project):
 *
 *   GET    /api/projects/:id/references             → ListProjectReferencesResponse
 *   POST   /api/projects/:id/references             AddProjectReferenceRequest → ProjectReferenceDto
 *   DELETE /api/projects/:id/references/:refId      → { ok: true }
 *   POST   /api/projects/:id/references/toggle      ToggleProjectReferenceRequest → ToggleProjectReferenceResponse
 */

export type ProjectReferenceKind =
  | 'design-system'
  | 'screenshot'
  | 'url'
  | 'figma';

export interface ProjectReferenceDto {
  id: string;
  kind: ProjectReferenceKind;
  /**
   * Kind-specific identifier:
   *   - design-system  → slug (e.g. "stripe", "linear-app")
   *   - screenshot     → relative path under .od/refs/<projectId>/
   *   - url            → absolute URL
   *   - figma          → Figma URL or `fileKey:nodeId`
   */
  value: string;
  /** Optional human-friendly label. */
  label: string | null;
  /** Optional free-text note ≤2000 chars. */
  note: string | null;
  createdAt: number;
}

export interface ListProjectReferencesResponse {
  references: ProjectReferenceDto[];
}

export interface AddProjectReferenceRequest {
  kind: ProjectReferenceKind;
  value: string;
  label?: string | null;
  note?: string | null;
}

export interface ToggleProjectReferenceRequest {
  kind: ProjectReferenceKind;
  value: string;
  label?: string | null;
  note?: string | null;
}

export type ToggleProjectReferenceResponse =
  | { state: 'added'; reference: ProjectReferenceDto }
  | { state: 'removed' };
