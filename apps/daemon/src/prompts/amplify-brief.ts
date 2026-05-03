/**
 * Brief amplification directive.
 *
 * Composed AFTER discovery and BEFORE the skill body. The intent — see
 * docs/prompt-engineering.md Layer 2 — is to capture the user's
 * implicit constraints in an explicit, schema-stable JSON block before
 * any HTML is produced. Downstream loops (lint→refine, visual critique,
 * pairwise judge) can then evaluate the artifact against the brief
 * rather than against vague free-text intent.
 *
 * This module is pure prompt — no LLM call, no endpoint. It tells the
 * agent to emit `<od-brief>` once, between the discovery answer and the
 * artifact generation. Behind the `OD_BRIEF_AMPLIFY` env flag while we
 * A/B; default off so existing flows are unchanged.
 *
 * Why prompt-only and not a separate small-model call? We do not own
 * the agent (per spec.md §2): if we add a hard dependency on a side
 * model, BYOK / no-key Topology C breaks. Asking the user's existing
 * agent to emit one extra JSON block is free and works in every
 * topology.
 */

export const AMPLIFY_BRIEF_DIRECTIVE = `## Brief amplification (one-time, after discovery)

After the user answers the discovery form (or, for short briefs, after
you have read the user's request once), and BEFORE you write any HTML,
emit ONE \`<od-brief>\` block that distills the user's intent into the
schema below. The block is for the system, not the user — output it,
then proceed to generation in the same turn. Do not ask the user to
confirm it; the user can edit it through the chat UI's brief-editor
overlay.

Why this matters. Downstream lint and critique passes compare the
artifact against this brief. A vague brief produces vague critique;
an explicit brief produces actionable critique. Be specific.

\`\`\`
<od-brief schema="v1">
{
  "summary":      "one paragraph; the artifact in plain language; ≤300 chars",
  "audience":     "who reads it; what they care about; ≤120 chars",
  "mood":         ["≤3 mood adjectives drawn from the active design system; lowercase"],
  "density":      "spacious | balanced | dense",
  "must_use":     ["explicit constraints — DESIGN.md tokens, skill seed paths, named components"],
  "must_avoid":   ["anti-slop hazards from craft/anti-ai-slop.md that could plausibly bite this brief"],
  "layout_reference": "≤120 chars; cite a skill, a screenshot, or a section pattern by name",
  "success_criteria": ["≤3 measurable checks the artifact must pass; phrased as testable assertions"]
}
</od-brief>
\`\`\`

Rules for the brief.

1. **Tokens, not adjectives, in \`must_use\`.** "Use \`var(--accent)\`"
   beats "use the brand color".
2. **Concrete hazards, not generic risks, in \`must_avoid\`.** "no
   purple→blue gradient hero" beats "avoid AI-slop look".
3. **Each \`success_criteria\` entry is measurable.** "passes
   \`lint-artifact\`" or "uses serif for h1/h2" beats "looks editorial".
4. **One brief per project.** If the user changes direction
   substantially mid-conversation, emit a fresh \`<od-brief>\` with
   schema=v1 to supersede the prior one.
5. **Echo, don't invent.** Do not introduce constraints the user did
   not state. If a field is unknown, omit the field rather than guess.

The brief does not replace the discovery form, the design system, or
craft references — it complements them by making the user's specific
intent legible.
`;
