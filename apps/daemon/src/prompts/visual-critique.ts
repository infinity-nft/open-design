/**
 * Visual self-critique directive.
 *
 * Composed AFTER the skill body and craft references; requires the
 * agent to emit a structured `<od-critique>` block AFTER the
 * `<artifact>` and BEFORE claiming the turn is done. The daemon's
 * stream parser extracts the block, emits a typed `critique-result`
 * SSE event, and the chat shell renders findings in the same kind of
 * card as `lint-result`.
 *
 * Why prompt-driven and not vision-API-driven (for now). A genuine
 * pixel-perfect critique requires (1) headless Chrome to render the
 * artifact, (2) a vision-capable side model, (3) an extra API call
 * we'd have to plumb through BYOK. None of that ships in this T1.1
 * MVP. The agent has already written the HTML, so it can self-critique
 * the *structure* — accent count, default-indigo, gradient hero, type
 * pairing — without seeing pixels. Pixel-only failures (geometry,
 * color clashes that depend on rendered values) come in T1.1b when
 * we add the screenshot pipeline.
 *
 * Critical guardrail from the 2025 Cell Patterns study on autonomous
 * critique loops. Pure closed loops converge to ~12 generic motifs
 * ("visual elevator music"). To prevent this, this directive caps at
 * **N=1** revision per turn (the agent revises once, then ships) and
 * keeps the *user reference* (DESIGN.md, brief mood, mood-board) as
 * the anchor. The pairwise judge in T1.2 will pick across variants;
 * within a single variant, one revise pass is enough.
 *
 * Uses the canonical 5-dimension rubric from `skills/critique/SKILL.md`
 * (Philosophy / Hierarchy / Detail / Functionality / Innovation) so the
 * inline self-critique speaks the same language as the full critique
 * skill. Scores are stored in `<od-critique>` schema="v2" and surfaced
 * in the chat card as score badges.
 *
 * Behind `OD_VISUAL_CRITIQUE` env flag while we A/B; default off.
 */

export const VISUAL_CRITIQUE_DIRECTIVE = `## Visual self-critique (one structured pass, after each artifact)

After every \`<artifact>\` you emit, run a self-critique pass and emit
ONE \`<od-critique>\` block using the schema below. The block drives
the chat layer's findings card and the auto-revise loop — it is not
prose for the user.

### 5-dimension evaluation framework

Score the artifact on each of these dimensions (0–10). Derive your
P0/P1/P2 findings from weak scores.

| Dimension | What to look for | Score → severity |
|-----------|-----------------|------------------|
| **philosophy** · consistency | One declared direction; every micro-decision argues for it (chrome, kicker, spacing, accent). Three styles fighting = low. | < 5 → P0; 5–6 → P1; ≥ 7 → no finding |
| **hierarchy** · visual layer | A stranger can tell what to read first, second, third. Everything shouting = low. | < 5 → P0; 5–6 → P1; ≥ 7 → no finding |
| **detail** · execution | Alignment, leading, kerning at large sizes, image framing, edge-case spacing. Visible tape-and-string = low. | < 5 → P0; 5–6 → P1; ≥ 7 → no finding |
| **functionality** · works for its job | Deck: nav works; landing: CTA above fold; runbook: code blocks copyable. Core flow broken = low. | < 5 → P0; 5–6 → P1; ≥ 7 → no finding |
| **innovation** · one memorable move | One unexpected layout / typographic / motion beat not required by the brief. Generic AI-slop median = 4. Innovation is *allowed* to be low for conservative deliverables. | < 5 → P1 (never P0) |

Scoring discipline:
- **Cite evidence.** "hierarchy 5 because page 3 has 4 competing
  display-weight elements" beats "feels cluttered". Numbers without
  evidence are not trusted.
- **Don't average up.** Score the *worst sustained band*, not the
  best pages.
- **Don't grade-inflate.** 7 means *strong*, not *acceptable*. If
  every dimension is 7+, you are not reviewing critically.

### Schema

\`\`\`
<od-critique schema="v2">
{
  "verdict": "ship | revise",
  "reasoning": "≤200 chars — one sentence on the overall judgment",
  "scores": {
    "philosophy":    0,
    "hierarchy":     0,
    "detail":        0,
    "functionality": 0,
    "innovation":    0
  },
  "findings": [
    {
      "severity": "P0 | P1 | P2",
      "rule": "dimension name (e.g. hierarchy), anti-ai-slop rule id, DESIGN.md token, or brief success_criteria index",
      "evidence": "≤120 chars — the offending snippet, selector, or section name",
      "fix": "≤180 chars — the concrete change to make"
    }
  ]
}
</od-critique>
\`\`\`

Every finding must be **specific and rule-tied**. A generic comment
like "the layout could be tighter" is not a finding. A good finding:

  > P0 · hierarchy — hero has 4 competing display-weight elements.
  > Fix: demote 3 to 24px semi-bold, keep only the H1 at 72px.

### Rules

1. **One pass per turn.** Do not loop critique → revise → critique
   inside a single turn. After the critique, if verdict is "revise",
   make the fixes silently and emit the *corrected* artifact with a
   final critique that has verdict="ship". Two artifact emits in a
   single turn is the cap; never more. (Anti-elevator-music guardrail
   — Cell Patterns 2025 on closed-loop convergence.)

2. **Empty findings is allowed.** If all 5 scores are ≥ 7, emit
   \`{ "verdict": "ship", "findings": [] }\` — do not invent findings
   to look thorough.

3. **Do not duplicate the linter.** The daemon runs a deterministic
   anti-slop linter (purple-gradient, default-indigo solid, emoji-icons,
   lorem filler, more-than-12-hex). Skip those — focus on what the
   regex linter cannot see: structure, hierarchy, brief alignment,
   copy specificity.

4. **Reference the brief when present.** If the conversation contains
   an \`<od-brief>\` block, P0 findings must cite a dimension score,
   a DESIGN.md token, or a success_criteria index. Unanchored P0s are
   treated as noise.

The critique block is mandatory when this directive is active.
`;
