/**
 * Multi-shot generation + pairwise judge directive.
 *
 * Prompt-driven implementation of plan T1.2 (Q0-4 in plan B). Instead
 * of orchestrating K parallel agent runs from the daemon — which would
 * triple cost, complicate cancellation, and require a separate judge
 * model — we ask the user's existing agent to:
 *
 *   1. Produce K=3 distinct artifact variants in the same turn, each in
 *      its own `<artifact id="variant-N">` block.
 *   2. Judge them pairwise against the brief (or, when no brief is
 *      present, against `craft/anti-ai-slop.md` and the active
 *      DESIGN.md).
 *   3. Emit ONE `<od-judge schema="v1">` block declaring the winner,
 *      ranking, and one-line rationale per variant.
 *
 * Why prompt-driven, not orchestrated. OD's spec.md §2 bet is "we don't
 * own the agent." Adding parallel multi-process orchestration assumes a
 * cost model and rate-limit posture that varies wildly across CLIs
 * (Copilot has different concurrency caps than Claude Code, Gemini CLI
 * does not parallelise, etc.). One agent producing K variants in one
 * turn is a portable contract; the agent decides how to budget tokens.
 *
 * Bias mitigation (per 2026 LLM-as-judge research). The directive
 * insists on:
 *   - Pairwise comparison, not pointwise scoring (drift is too high
 *     for absolute scores).
 *   - Both orderings of each pair (A-vs-B AND B-vs-A) before the
 *     verdict — the agent runs them mentally and returns only the
 *     final consensus, not the raw pair table.
 *   - Position-bias awareness (instruction to ignore "first variant
 *     read" preference).
 *   - Verbosity-bias awareness (instruction to weight content over
 *     length).
 *   - No self-preference language (the agent does not call any
 *     variant "mine"; they are A/B/C).
 *
 * Anti-elevator-music. The directive caps K at 3 and forbids
 * regenerating after the verdict. The user picks among the three; if
 * none is acceptable they can run again with a different brief, not
 * loop the agent.
 *
 * Behind `OD_MULTI_SHOT` env flag while we A/B; default off. Setting
 * the flag to a number (`OD_MULTI_SHOT=2` or `=3`) sets K explicitly;
 * `OD_MULTI_SHOT=1` is equivalent to off.
 */

const DEFAULT_K = 3;

export interface MultiShotConfig {
  k: number;
}

export function readMultiShotFlag(): MultiShotConfig | null {
  const raw = process.env.OD_MULTI_SHOT;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '0' || trimmed === 'false' || trimmed === 'off') return null;
  if (trimmed === '1') return null; // K=1 is the existing single-shot path
  if (trimmed === 'true' || trimmed === 'on') return { k: DEFAULT_K };
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 2) return null;
  // Clamp to a sane upper bound; K=5 for HTML deck variants is already
  // expensive and the marginal taste benefit drops fast past 3.
  return { k: Math.min(parsed, 5) };
}

export function multiShotDirective(k: number): string {
  return `## Multi-shot generation (${k} variants this turn)

This turn produces **${k} distinct variants** of the requested artifact,
followed by a pairwise judgment that picks one as the default. The
chat shell shows the winner first; the user can switch to the others
through the variant picker.

### How to vary

The variants must differ on a *load-bearing* dimension — not just
trivial swaps. Pick the dimension that most affects taste, given the
brief:

  - **Layout** (e.g. centered hero vs. side-by-side vs. asymmetric grid)
  - **Type system** (display serif vs. neo-grotesque vs. mono-display)
  - **Color story** (within the brand's tokens — e.g. dark surface vs.
    light editorial vs. duotone monochrome)
  - **Density** (spacious vs. dense — within the brief's stated density)

Pick ONE dimension; do not vary all four at once. All ${k} variants
must still satisfy every \`must_use\` from the brief and pass
\`craft/anti-ai-slop.md\`.

### How to emit

\`\`\`
<artifact id="variant-A" data-variant-axis="layout">
…HTML for variant A…
</artifact>

<artifact id="variant-B" data-variant-axis="layout">
…HTML for variant B…
</artifact>

<artifact id="variant-C" data-variant-axis="layout">
…HTML for variant C…
</artifact>

<od-judge schema="v1">
{
  "winner": "A | B | C",
  "axis": "layout | type | color | density",
  "ranking": ["A", "B", "C"],
  "rationale": [
    { "variant": "A", "verdict": "win",       "why": "≤140 chars — WHY THIS WON: the specific thing it nails that the others don't" },
    { "variant": "B", "verdict": "runner-up", "why": "≤140 chars — what it does well and the one specific thing that costs it first place" },
    { "variant": "C", "verdict": "last",      "why": "≤140 chars — its core strength and the concrete reason it ranked last" }
  ],
  "confidence": "high | medium | low"
}
</od-judge>
\`\`\`

### Judging rules

1. **Pairwise, not pointwise.** Compare A-vs-B, B-vs-C, A-vs-C
   silently before deciding the ranking. Do not output absolute
   scores — they drift between runs.

2. **Both orderings.** For each pair, ask "is A better than B?" AND
   "is B better than A?" The answer should be consistent; if it is
   not, mark confidence as "low" and ship the verdict that satisfies
   the brief's success_criteria more directly.

3. **Bias guards.**
   - Position bias: the first variant should not win because it was
     read first. Read in shuffled order before deciding.
   - Verbosity bias: more HTML is not better. Reward intentional
     density and intentional restraint equally.
   - Self-preference: speak of A/B/C, never "the first one I made"
     or "this one feels right". Tie verdicts to the brief and
     anti-slop rules, not vibes.
   - Authority: do not weight a variant higher because its copy
     claims expertise.

4. **Anchor to the brief, not vibes.** When an \`<od-brief>\` is
   present, every \`why\` line should cite a \`success_criteria\`
   index, a token name, or an anti-slop rule id. "Variant A wins:
   serif type pairs better with editorial mood (success_criteria #2)"
   beats "Variant A feels more refined".

   The winner's \`why\` is shown as a headline to the user. Write it
   as a complete, self-contained design statement — not a comparison
   ("unlike B"), not a fragment ("good hierarchy"). Good example:
   "Asymmetric grid anchors the hero at 70vw and leaves breathing room
   for the metrics row (success_criteria #1 + #3)."

5. **One pass.** Do not re-judge after declaring a winner. Do not
   regenerate variants in this turn after \`<od-judge>\` is emitted.
   The user picks among the three; if none works, they will
   re-prompt.

### Cost note

This turn costs ~${k}× the tokens of a single-variant turn. The chat
header shows running cost; the user opted in.
`;
}
