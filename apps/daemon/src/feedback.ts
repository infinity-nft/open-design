// @ts-nocheck
/**
 * Feedback signal derivation. Pure helpers used by the
 * `POST /api/feedback` handler — extracted so they are testable
 * without spinning up the full daemon.
 */

interface ProjectLite {
  skillId?: string | null;
  designSystemId?: string | null;
  metadata?: { tone?: unknown } | null;
}

interface FeedbackSubjectsInput {
  project?: ProjectLite | null;
  /**
   * Override skill / design-system ids when the project record is
   * absent (ad-hoc / no-project chats) or stale. The project values
   * win when both are provided so the feedback survives changes the
   * user made AFTER the run was generated.
   */
  skillIdOverride?: string | null;
  designSystemIdOverride?: string | null;
}

/**
 * Derive the list of taste-memory subjects to record from a feedback
 * click. Returns `['feedback:run']` as a fallback when no context is
 * available so the click is not lost (the aggregator's threshold
 * filters those out unless many accumulate).
 */
export function deriveFeedbackSubjects(input: FeedbackSubjectsInput): string[] {
  const subjects: string[] = [];
  const project = input.project ?? null;
  const skillId = project?.skillId ?? input.skillIdOverride ?? null;
  const designSystemId = project?.designSystemId ?? input.designSystemIdOverride ?? null;

  if (skillId) subjects.push(`skill:${String(skillId).toLowerCase()}`);
  if (designSystemId) subjects.push(`design-system:${String(designSystemId).toLowerCase()}`);

  const tone = project?.metadata?.tone;
  if (Array.isArray(tone)) {
    for (const t of tone.slice(0, 3)) {
      if (typeof t === 'string' && t.trim()) {
        subjects.push(`mood:${t.trim().toLowerCase()}`);
      }
    }
  }

  if (subjects.length === 0) subjects.push('feedback:run');
  return subjects;
}
