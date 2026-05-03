/**
 * Prompt composer. The base is the OD-adapted "expert designer" system
 * prompt (see ./official-system.ts) — a full identity, workflow, and
 * content-philosophy charter. Stacked on top:
 *
 *   1. The discovery + planning + huashu-philosophy layer (./discovery.ts)
 *      — interactive question-form syntax, direction-picker fork,
 *      brand-spec extraction, TodoWrite reinforcement, 5-dim critique,
 *      and the embedded `directions.ts` library.
 *   2. The active design system's DESIGN.md (if any) — palette, typography,
 *      spacing rules treated as authoritative tokens.
 *   3. The active skill's SKILL.md (if any) — workflow specific to the
 *      kind of artifact being built. When the skill ships a seed
 *      (`assets/template.html`) and references (`references/layouts.md`,
 *      `references/checklist.md`), we inject a hard pre-flight rule above
 *      the skill body so the agent reads them BEFORE writing any code.
 *   4. For decks (skillMode === 'deck' OR metadata.kind === 'deck'), the
 *      deck framework directive (./deck-framework.ts) is pinned LAST so it
 *      overrides any softer slide-handling wording earlier in the stack —
 *      this is the load-bearing nav / counter / scroll JS / print
 *      stylesheet contract that PDF stitching depends on. We also fire on
 *      the metadata path so deck-kind projects without a bound skill
 *      (skill_id null) still get a framework, instead of having the agent
 *      re-author scaling / nav / print logic from scratch each turn. When
 *      the active skill ships its own seed (skill body references
 *      `assets/template.html`), we defer to that seed and skip the generic
 *      skeleton — the skill's framework wins to avoid double-injection.
 *
 * The composed string is what the daemon sees as `systemPrompt` and what
 * the Anthropic path sends as `system`.
 */
import { OFFICIAL_DESIGNER_PROMPT } from './official-system.js';
import { DISCOVERY_AND_PHILOSOPHY } from './discovery.js';
import { DECK_FRAMEWORK_DIRECTIVE } from './deck-framework.js';
import { MEDIA_GENERATION_CONTRACT } from './media-contract.js';
import { AMPLIFY_BRIEF_DIRECTIVE } from './amplify-brief.js';
import { VISUAL_CRITIQUE_DIRECTIVE } from './visual-critique.js';
import { multiShotDirective, readMultiShotFlag } from './multi-shot.js';
import { SKILL_DEFENSIVE_PREAMBLE } from '../skills-sanitize.js';

// Brief amplification is gated by env flag while we A/B. When on, the
// agent emits a structured `<od-brief>` block after discovery and before
// the artifact, which downstream lint/critique passes use as the
// success-criteria reference. Default off; flip to "1" to enable.
const BRIEF_AMPLIFY_ENABLED =
  process.env.OD_BRIEF_AMPLIFY === '1' ||
  process.env.OD_BRIEF_AMPLIFY === 'true';

// Visual self-critique is also flag-gated. When on, the agent emits a
// structured `<od-critique>` block after each `<artifact>`. The daemon
// stream parser extracts it and surfaces findings in the chat alongside
// the deterministic linter's findings. See specs/current/master-plan-2026-05.md
// T1.1 and docs/prompt-engineering.md Layer 4.
const VISUAL_CRITIQUE_ENABLED =
  process.env.OD_VISUAL_CRITIQUE === '1' ||
  process.env.OD_VISUAL_CRITIQUE === 'true';

type ProjectMetadata = {
  kind?: string;
  fidelity?: string | null;
  speakerNotes?: boolean | null;
  animations?: boolean | null;
  templateId?: string | null;
  templateLabel?: string | null;
  inspirationDesignSystemIds?: string[];
  imageModel?: string | null;
  imageAspect?: string | null;
  imageStyle?: string | null;
  videoModel?: string | null;
  videoLength?: number | null;
  videoAspect?: string | null;
  audioKind?: string | null;
  audioModel?: string | null;
  audioDuration?: number | null;
  voice?: string | null;
  promptTemplate?: {
    id?: string | null;
    surface?: 'image' | 'video' | null;
    title?: string | null;
    prompt?: string | null;
    summary?: string | null;
    category?: string | null;
    tags?: string[] | null;
    model?: string | null;
    aspect?: string | null;
    source?: {
      repo?: string | null;
      license?: string | null;
      author?: string | null;
      url?: string | null;
    } | null;
  } | null;
};
type ProjectTemplate = { name: string; description?: string | null; files: Array<{ name: string; content: string }> };

type ProjectReferenceForPrompt = {
  kind: 'design-system' | 'screenshot' | 'url' | 'figma';
  value: string;
  label?: string | null;
  note?: string | null;
};

type TasteAggregateForPrompt = {
  subject: string;
  score: number;
  count: number;
  confidence: 'high' | 'medium' | 'low';
};

export const BASE_SYSTEM_PROMPT = OFFICIAL_DESIGNER_PROMPT;

export interface ComposeInput {
  skillBody?: string | undefined;
  skillName?: string | undefined;
  skillMode?:
    | 'prototype'
    | 'deck'
    | 'template'
    | 'design-system'
    | 'image'
    | 'video'
    | 'audio'
    | undefined;
  designSystemBody?: string | undefined;
  designSystemTitle?: string | undefined;
  // Craft references the active skill opted into via `od.craft.requires`.
  // The daemon resolves the slug list to file contents and concatenates
  // them with section headers; we inject them between the DESIGN.md and
  // the skill body so brand tokens win on conflict but craft rules
  // (letter-spacing, accent caps, anti-slop) cover everything below.
  craftBody?: string | undefined;
  craftSections?: string[] | undefined;
  // Project-level metadata captured by the new-project panel. Drives the
  // agent's understanding of artifact kind, fidelity, speaker-notes intent
  // and animation intent. Missing fields here are exactly what the
  // discovery form should re-ask the user about on turn 1.
  metadata?: ProjectMetadata | undefined;
  // The template the user picked in the From-template tab, when present.
  // Snapshot of HTML files that the agent should treat as a starting
  // reference rather than a fixed deliverable.
  template?: ProjectTemplate | undefined;
  // User-curated taste signals stored under `project_references` (T2.1).
  // Surfaced as a "User-curated references" block so the agent treats
  // these as default tone preferences when free to choose, without
  // overriding the brief or the active DESIGN.md. Empty / undefined
  // skips the block entirely.
  references?: ProjectReferenceForPrompt[] | undefined;
  // Derived taste profile from `taste_signals` (T2.2). Each scope is
  // independently aggregated by the daemon and passed in already-
  // ranked. The injection block frames these as PROBABILISTIC defaults
  // ("may be wrong"), per docs/prompt-engineering.md Layer 6 — never
  // hard constraints, so the agent can step out of them when the
  // brief contradicts.
  tasteUserLevel?: TasteAggregateForPrompt[] | undefined;
  tasteProjectLevel?: TasteAggregateForPrompt[] | undefined;
  tasteSessionLevel?: TasteAggregateForPrompt[] | undefined;
}

export function composeSystemPrompt({
  skillBody,
  skillName,
  skillMode,
  designSystemBody,
  designSystemTitle,
  craftBody,
  craftSections,
  metadata,
  template,
  references,
  tasteUserLevel,
  tasteProjectLevel,
  tasteSessionLevel,
}: ComposeInput): string {
  // Discovery + philosophy goes FIRST so its hard rules ("emit a form on
  // turn 1", "branch on brand on turn 2", "TodoWrite on turn 3", run
  // checklist + critique before <artifact>) win precedence over softer
  // wording later in the official base prompt.
  const parts: string[] = [
    DISCOVERY_AND_PHILOSOPHY,
    '\n\n---\n\n# Identity and workflow charter (background)\n\n',
    BASE_SYSTEM_PROMPT,
  ];

  // Brief amplification fits between the discovery layer (turn-1 form)
  // and the design system (which is the source of truth for tokens the
  // brief cites). Inserting it here keeps the JSON schema instructions
  // close to the discovery flow they extend. See
  // docs/prompt-engineering.md Layer 2.
  if (BRIEF_AMPLIFY_ENABLED) {
    parts.push('\n\n---\n\n', AMPLIFY_BRIEF_DIRECTIVE);
  }

  if (designSystemBody && designSystemBody.trim().length > 0) {
    parts.push(
      `\n\n## Active design system${designSystemTitle ? ` — ${designSystemTitle}` : ''}\n\nTreat the following DESIGN.md as authoritative for color, typography, spacing, and component rules. Do not invent tokens outside this palette. When you copy the active skill's seed template, bind these tokens into its \`:root\` block before generating any layout.\n\n${designSystemBody.trim()}`,
    );
  }

  if (craftBody && craftBody.trim().length > 0) {
    const sectionLabel =
      Array.isArray(craftSections) && craftSections.length > 0
        ? ` — ${craftSections.join(', ')}`
        : '';
    parts.push(
      `\n\n## Active craft references${sectionLabel}\n\nThe following craft rules are universal — they apply on top of the active design system above, regardless of brand. The DESIGN.md decides *which* tokens to use; craft rules decide *how* to use them. On any conflict between a craft rule and a brand DESIGN.md, the brand wins for token values; craft rules still apply to anything the brand does not override (letter-spacing, accent overuse caps, anti-slop patterns).\n\n${craftBody.trim()}`,
    );
  }

  if (skillBody && skillBody.trim().length > 0) {
    const preflight = derivePreflight(skillBody);
    // SKILL_DEFENSIVE_PREAMBLE marks the skill body as untrusted reference
    // material so a hostile skill (hidden-comment injection, claim-of-
    // priority phrasing) cannot redirect the agent to access files or
    // tools the user did not request. The mechanical sanitizer runs in
    // skills.ts; this preamble is the prompt-level half. See
    // docs/prompt-engineering.md Layer 3.
    parts.push(
      `\n\n## Active skill${skillName ? ` — ${skillName}` : ''}\n\nFollow this skill's workflow exactly.${preflight}\n\n${SKILL_DEFENSIVE_PREAMBLE}${skillBody.trim()}`,
    );
  }

  const metaBlock = renderMetadataBlock(metadata, template);
  if (metaBlock) parts.push(metaBlock);

  const refsBlock = renderReferencesBlock(references);
  if (refsBlock) parts.push(refsBlock);

  const tasteBlock = renderTasteBlock(tasteUserLevel, tasteProjectLevel, tasteSessionLevel);
  if (tasteBlock) parts.push(tasteBlock);

  // Decks have a load-bearing framework (nav, counter, scroll JS, print
  // stylesheet for PDF stitching). Pin it last so it overrides any softer
  // wording earlier in the stack ("write a script that handles arrows…").
  //
  // We fire on either (a) the active skill is a deck skill OR (b) the
  // project metadata declares kind=deck. Case (b) catches projects created
  // without a skill (skill_id null) — without this, a deck-kind project
  // with no bound skill gets neither a skill seed nor the framework
  // skeleton, and the agent writes scaling / nav / print logic from scratch
  // with the same buggy `place-items: center` + transform pattern we keep
  // having to fix at runtime. Skill seeds (when present) win — they
  // already define their own opinionated framework (simple-deck's
  // scroll-snap, guizang-ppt's magazine layout) and re-pinning the generic
  // skeleton would conflict. The skill-seed path takes over via
  // `derivePreflight` above, so we only fire the generic skeleton when no
  // skill seed is on offer.
  const isDeckProject = skillMode === 'deck' || metadata?.kind === 'deck';
  const hasSkillSeed =
    !!skillBody && /assets\/template\.html/.test(skillBody);
  if (isDeckProject && !hasSkillSeed) {
    parts.push(`\n\n---\n\n${DECK_FRAMEWORK_DIRECTIVE}`);
  }

  const isMediaSurface =
    skillMode === 'image' ||
    skillMode === 'video' ||
    skillMode === 'audio' ||
    metadata?.kind === 'image' ||
    metadata?.kind === 'video' ||
    metadata?.kind === 'audio';
  if (isMediaSurface) {
    parts.push(MEDIA_GENERATION_CONTRACT);
  }

  // Visual self-critique pins LAST so it sees every other directive
  // (skill workflow, design system, craft rules, deck framework) and
  // can reference them by name in findings. Skip on media surfaces —
  // image/video/audio artifacts have a different review surface
  // (vendor preview links, not HTML structure).
  if (VISUAL_CRITIQUE_ENABLED && !isMediaSurface) {
    parts.push('\n\n---\n\n', VISUAL_CRITIQUE_DIRECTIVE);
  }

  // Multi-shot generation pins after the critique directive so the
  // K-variant rule (one judge, one ranking) overrides any "emit one
  // artifact per turn" wording earlier in the stack. Skip on media
  // surfaces; variants of an image/video/audio asset would be K
  // separate vendor calls, not K HTML blocks. See T1.2.
  const multiShot = readMultiShotFlag();
  if (multiShot && !isMediaSurface) {
    parts.push('\n\n---\n\n', multiShotDirective(multiShot.k));
  }

  return parts.join('');
}

function renderTasteBlock(
  userLevel: TasteAggregateForPrompt[] | undefined,
  projectLevel: TasteAggregateForPrompt[] | undefined,
  sessionLevel: TasteAggregateForPrompt[] | undefined,
): string {
  const u = userLevel ?? [];
  const p = projectLevel ?? [];
  const s = sessionLevel ?? [];
  if (u.length === 0 && p.length === 0 && s.length === 0) return '';

  const lines: string[] = [];
  lines.push('\n\n## Learned user preferences (derived from past sessions, may be wrong)');
  lines.push('');
  lines.push(
    'The following is a **probabilistic** summary of this user\'s accepted patterns, computed from their past accept / reject / comment-mode events. Treat it as a **default**, not a constraint. If the brief asks for something different, the brief wins. The profile will adjust on the next user feedback.',
  );
  lines.push('');
  lines.push(
    'Layering: project-level entries override user-level entries when they disagree; session-level entries override both (they are this conversation\'s recent shifts). Confidence labels: **high** = ≥10 supporting signals with consistent direction, **medium** = ≥5 signals, **low** = ≤4 signals (emerging).',
  );
  lines.push('');

  if (u.length > 0) {
    lines.push('### User-level (across all projects)');
    lines.push('');
    for (const t of u) lines.push(formatTasteRow(t));
    lines.push('');
  }
  if (p.length > 0) {
    lines.push('### Project-level (this project only)');
    lines.push('');
    for (const t of p) lines.push(formatTasteRow(t));
    lines.push('');
  }
  if (s.length > 0) {
    lines.push('### Session-level (this conversation)');
    lines.push('');
    for (const t of s) lines.push(formatTasteRow(t));
    lines.push('');
  }

  return lines.join('\n');
}

function formatTasteRow(t: TasteAggregateForPrompt): string {
  const direction = t.score > 0 ? 'prefer' : 'avoid';
  return `- ${direction} \`${t.subject}\` *(confidence: ${t.confidence}, score ${t.score >= 0 ? '+' : ''}${t.score}, ${t.count} signal${t.count === 1 ? '' : 's'})*`;
}

function renderReferencesBlock(
  references: ProjectReferenceForPrompt[] | undefined,
): string {
  if (!Array.isArray(references) || references.length === 0) return '';

  // Group by kind so the agent can scan for "design tone signals" vs.
  // "concrete URL/Figma references" without parsing each line.
  const byKind = new Map<string, ProjectReferenceForPrompt[]>();
  for (const ref of references) {
    if (!byKind.has(ref.kind)) byKind.set(ref.kind, []);
    byKind.get(ref.kind)!.push(ref);
  }

  const lines: string[] = [];
  lines.push('\n\n## User-curated references');
  lines.push('');
  lines.push(
    'The user has starred the following references for this project. Treat them as **taste signals**: when free to choose between equally-valid options, prefer choices that echo these references. They do **not** override the active DESIGN.md (which is the source of truth for tokens) or the brief\'s explicit constraints.',
  );
  lines.push('');

  const designSystems = byKind.get('design-system') ?? [];
  if (designSystems.length > 0) {
    lines.push('### Starred design systems');
    lines.push('');
    lines.push(
      `The user tends to like the tone, palette, and typographic personality of these systems: **${designSystems
        .map((r) => r.value)
        .join(', ')}**. When picking accent intensity, type pairings, or rhythm without other guidance, lean toward what these systems do.`,
    );
    lines.push('');
  }

  const screenshots = byKind.get('screenshot') ?? [];
  const urls = byKind.get('url') ?? [];
  const figma = byKind.get('figma') ?? [];
  if (screenshots.length > 0 || urls.length > 0 || figma.length > 0) {
    lines.push('### Concrete references');
    lines.push('');
    for (const r of urls) {
      lines.push(`- URL: ${r.value}${r.label ? ` — ${r.label}` : ''}${r.note ? ` *(${r.note})*` : ''}`);
    }
    for (const r of figma) {
      lines.push(`- Figma: ${r.value}${r.label ? ` — ${r.label}` : ''}${r.note ? ` *(${r.note})*` : ''}`);
    }
    for (const r of screenshots) {
      lines.push(`- Screenshot: ${r.value}${r.label ? ` — ${r.label}` : ''}${r.note ? ` *(${r.note})*` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderMetadataBlock(
  metadata: ProjectMetadata | undefined,
  template: ProjectTemplate | undefined,
): string {
  if (!metadata) return '';
  const lines: string[] = [];
  lines.push('\n\n## Project metadata');
  lines.push(
    'These are the structured choices the user made (or skipped) when creating this project. Treat known fields as authoritative; for any field marked "(unknown — ask)" you MUST include a matching question in your turn-1 discovery form.',
  );
  lines.push('');
  lines.push(`- **kind**: ${metadata.kind}`);

  if (metadata.kind === 'prototype') {
    lines.push(
      `- **fidelity**: ${metadata.fidelity ?? '(unknown — ask: wireframe vs high-fidelity)'}`,
    );
  }
  if (metadata.kind === 'deck') {
    lines.push(
      `- **speakerNotes**: ${typeof metadata.speakerNotes === 'boolean' ? metadata.speakerNotes : '(unknown — ask: include speaker notes?)'}`,
    );
  }
  if (metadata.kind === 'template') {
    lines.push(
      `- **animations**: ${typeof metadata.animations === 'boolean' ? metadata.animations : '(unknown — ask: include motion/animations?)'}`,
    );
    if (metadata.templateLabel) {
      lines.push(`- **template**: ${metadata.templateLabel}`);
    }
  }
  if (metadata.kind === 'image') {
    lines.push(
      `- **imageModel**: ${metadata.imageModel ?? '(unknown — ask: which image model to use)'}`,
    );
    lines.push(
      `- **aspectRatio**: ${metadata.imageAspect ?? '(unknown — ask: 1:1, 16:9, 9:16, 4:3, 3:4)'}`,
    );
    if (metadata.imageStyle) {
      lines.push(`- **styleNotes**: ${metadata.imageStyle}`);
    }
    if (
      metadata.promptTemplate?.title &&
      typeof metadata.promptTemplate.prompt === 'string' &&
      metadata.promptTemplate.prompt.trim().length > 0
    ) {
      lines.push(`- **referenceTemplate**: ${metadata.promptTemplate.title}`);
    }
    lines.push('');
    lines.push(
      'This is an **image** project. Plan the prompt carefully, then dispatch via the **media generation contract** using `od media generate --surface image --model <imageModel>`. Do NOT emit `<artifact>` HTML for media surfaces.',
    );
  }
  if (metadata.kind === 'video') {
    lines.push(
      `- **videoModel**: ${metadata.videoModel ?? '(unknown — ask: which video model to use)'}`,
    );
    lines.push(
      `- **lengthSeconds**: ${typeof metadata.videoLength === 'number' ? metadata.videoLength : '(unknown — ask: 3s / 5s / 10s)'}`,
    );
    lines.push(
      `- **aspectRatio**: ${metadata.videoAspect ?? '(unknown — ask: 16:9, 9:16, 1:1)'}`,
    );
    if (
      metadata.promptTemplate?.title &&
      typeof metadata.promptTemplate.prompt === 'string' &&
      metadata.promptTemplate.prompt.trim().length > 0
    ) {
      lines.push(`- **referenceTemplate**: ${metadata.promptTemplate.title}`);
    }
    lines.push('');
    lines.push(
      'This is a **video** project. Plan the shotlist and motion, then dispatch via the **media generation contract** using `od media generate --surface video --model <videoModel> --length <seconds> --aspect <ratio>`. Do NOT emit `<artifact>` HTML.',
    );
    if (metadata.videoModel === 'hyperframes-html') {
      lines.push(
        'Special case: `hyperframes-html` is a local HTML-to-MP4 renderer, not a photoreal text-to-video model. Treat it like a motion design renderer, ask at most one clarifying question, then dispatch immediately.',
      );
    }
  }
  if (metadata.kind === 'audio') {
    lines.push(
      `- **audioKind**: ${metadata.audioKind ?? '(unknown — ask: music / speech / sfx)'}`,
    );
    lines.push(
      `- **audioModel**: ${metadata.audioModel ?? '(unknown — ask: which audio model to use)'}`,
    );
    lines.push(
      `- **durationSeconds**: ${typeof metadata.audioDuration === 'number' ? metadata.audioDuration : '(unknown — ask: target duration)'}`,
    );
    if (metadata.voice) {
      lines.push(`- **voice**: ${metadata.voice}`);
    } else if (metadata.audioKind === 'speech') {
      lines.push('- **voice**: (unknown — ask: voice id / accent / pacing)');
    }
    lines.push('');
    lines.push(
      'This is an **audio** project. Lock the content intent first, then dispatch via the **media generation contract** using `od media generate --surface audio --audio-kind <kind> --model <audioModel> --duration <seconds>` and add `--voice <voice-id>` for speech when you have a provider-specific voice id. Do NOT emit `<artifact>` HTML.',
    );
  }

  if (metadata.inspirationDesignSystemIds && metadata.inspirationDesignSystemIds.length > 0) {
    lines.push(
      `- **inspirationDesignSystemIds**: ${metadata.inspirationDesignSystemIds.join(', ')} — the user picked these systems as *additional* inspiration alongside the primary one. Borrow palette accents, typographic personality, or component patterns from them; don't replace the primary system's tokens.`,
    );
  }

  // Curated prompt template reference for image/video projects. Inlined
  // verbatim (with light truncation) so the agent can borrow structure,
  // mood and phrasing without a separate fetch. The user may have edited
  // the body before clicking Create — those edits land here and are now
  // authoritative for the brief.
  if (
    (metadata.kind === 'image' || metadata.kind === 'video') &&
    metadata.promptTemplate &&
    typeof metadata.promptTemplate.prompt === 'string' &&
    metadata.promptTemplate.prompt.trim().length > 0
  ) {
    const tpl = metadata.promptTemplate;
    lines.push('');
    lines.push(`### Reference prompt template — "${tpl.title ?? 'untitled'}"`);
    const meta = [];
    if (tpl.category) meta.push(`category: ${tpl.category}`);
    if (tpl.model) meta.push(`suggested model: ${tpl.model}`);
    if (tpl.aspect) meta.push(`aspect: ${tpl.aspect}`);
    if (Array.isArray(tpl.tags) && tpl.tags.length > 0) {
      meta.push(`tags: ${tpl.tags.join(', ')}`);
    }
    if (meta.length > 0) lines.push(meta.join(' · '));
    if (tpl.summary) {
      lines.push('');
      lines.push(tpl.summary);
    }
    lines.push('');
    lines.push(
      'The user picked this template as inspiration. Treat it as a structural and stylistic reference: borrow composition, palette cues, lighting language, lens/motion direction, and the level of detail. Adapt the wording to the user\'s actual subject and brief — do NOT generate the template subject verbatim. If a field above is unknown the user wants you to follow the template\'s defaults.',
    );
    // Escape triple-backticks so a user who pastes ``` into the editable
    // template body can't break out of the markdown fence below and inject
    // free-form instructions into the agent's system prompt.
    const safe = (tpl.prompt ?? '').replace(/```/g, '`\u200b`\u200b`');
    const truncated =
      safe.length > 4000
        ? `${safe.slice(0, 4000)}\n… (truncated ${safe.length - 4000} chars)`
        : safe;
    lines.push('');
    lines.push('```text');
    lines.push(truncated);
    lines.push('```');
    if (tpl.source) {
      const author = tpl.source.author ? ` by ${tpl.source.author}` : '';
      lines.push('');
      lines.push(
        `Source: ${tpl.source.repo}${author} — license ${tpl.source.license ?? 'unspecified'}. Preserve attribution if you echo the template language directly.`,
      );
    }
  }

  if (metadata.kind === 'template' && template && template.files.length > 0) {
    lines.push('');
    lines.push(
      `### Template reference — "${template.name}"${template.description ? ` (${template.description})` : ''}`,
    );
    lines.push(
      'These HTML snapshots are what the user wants to start FROM. Read them as a stylistic + structural reference. You may copy structure, palette, typography, and component patterns; you may adapt them to the new brief; do NOT ship them verbatim. The agent should still produce its own artifact, just one that visibly inherits this template\'s design language.',
    );
    for (const f of template.files) {
      // Cap each file at ~12k chars so a giant template doesn't blow out
      // the system prompt budget. The agent gets enough to read structure.
      const truncated =
        f.content.length > 12000
          ? `${f.content.slice(0, 12000)}\n<!-- … truncated (${f.content.length - 12000} chars omitted) -->`
          : f.content;
      lines.push('');
      lines.push(`#### \`${f.name}\``);
      lines.push('```html');
      lines.push(truncated);
      lines.push('```');
    }
  }

  return lines.join('\n');
}

/**
 * Detect the seed/references pattern shipped by the upgraded
 * web-prototype / mobile-app / simple-deck / guizang-ppt skills, and
 * inject a hard pre-flight rule that lists which side files to Read
 * before doing anything else. The skill body's own workflow already says
 * this — but skills get truncated under context pressure and the agent
 * sometimes skips Step 0. A short up-front directive helps.
 *
 * Returns an empty string when the skill ships no side files (legacy
 * SKILL.md-only skills) so we don't add noise.
 */
function derivePreflight(skillBody: string): string {
  const refs: string[] = [];
  if (/assets\/template\.html/.test(skillBody)) refs.push('`assets/template.html`');
  if (/references\/layouts\.md/.test(skillBody)) refs.push('`references/layouts.md`');
  if (/references\/themes\.md/.test(skillBody)) refs.push('`references/themes.md`');
  if (/references\/components\.md/.test(skillBody)) refs.push('`references/components.md`');
  if (/references\/checklist\.md/.test(skillBody)) refs.push('`references/checklist.md`');
  if (refs.length === 0) return '';
  return ` **Pre-flight (do this before any other tool):** Read ${refs.join(', ')} via the path written in the skill-root preamble. The seed template defines the class system you'll paste into; the layouts file is the only acceptable source of section/screen/slide skeletons; the checklist is your P0/P1/P2 gate before emitting \`<artifact>\`. Skipping this step is the #1 reason output regresses to generic AI-slop.`;
}
