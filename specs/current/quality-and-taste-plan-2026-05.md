# Quality and Taste Plan — 2026-05

## Purpose

Companion to `improvement-plan-2026-05.md`. That document targets security,
reliability, and ecosystem alignment. **This document targets output quality
and personalization** — i.e. the two questions the user actually feels:

1. **"Are the generated designs actually good?"** (taste, polish, anti-slop)
2. **"Does the system understand me?"** (memory, references, iteration loops)

The existing system already has a strong foundation for this work:

- `craft/anti-ai-slop.md` — codified taste rules with auto-linter
  (`apps/daemon/src/lint-artifact.ts`)
- `design-systems/*/DESIGN.md` — 100+ brand-tone references
- `skills/critique/` — 5-dimension expert review skill
- `skills/design-brief/`, `skills/design-system/` — brief and system
  bootstrapping

The plan below extends these with **a generation pipeline** (brief → multi-shot
→ visual self-critique → judge → revise) and **a personalization layer**
(user taste memory, reference library, learned preferences).

## Priority Scale

| Priority | Meaning |
|---|---|
| Q0 | Foundational quality lift. Big effect for low effort. |
| Q1 | Taste personalization. Compounds over weeks of use. |
| Q2 | Advanced iteration loops. Best when Q0/Q1 are in place. |

---

## Q0 — Foundational quality lift (do these first)

### Q0-1. Brief amplification step

- **Problem.** A user prompt like *"Airbnb-style search page, use our design
  system"* is under-specified. The agent fills the gaps with whatever the
  base model finds plausible — that is exactly where AI-slop comes from.
- **Practice.** Before dispatching to the agent, run a **brief amplifier**
  prompt (small, fast model — Haiku-class) that transforms the user's
  one-liner into a structured brief: audience, mood/voice, density,
  layout reference, hard constraints from `DESIGN.md`, anti-slop pre-flight.
- **Where.** New module `apps/daemon/src/prompts/amplify-brief.ts`. Insert in
  the chat pipeline before the agent adapter is invoked. Render the
  amplified brief in the chat UI as a collapsible "expanded brief" block —
  the user can edit before generation runs.
- **Output schema.** JSON, stable shape:
  ```json
  {
    "summary": "…",
    "audience": "…",
    "mood": ["editorial", "calm", "trustworthy"],
    "density": "spacious | balanced | dense",
    "must_use": ["--accent from DESIGN.md", "serif for display"],
    "must_avoid": ["indigo gradient", "emoji icons"],
    "layout_reference": "skill: airbnb · section pattern: side-by-side filters",
    "success_criteria": ["passes lint", "feels like Airbnb, not v0 default"]
  }
  ```
- **Effort.** 2 days.
- **Validation.** A/B against a held-out set of 20 prompts: human prefers
  amplified-brief output ≥ 70% of the time.

### Q0-2. Anti-slop linter → refinement loop

- **Problem.** `lint-artifact.ts` already detects the seven cardinal sins
  (default-Tailwind-indigo, two-stop trust gradient, emoji-as-icon, …).
  Today the findings are surfaced as a P0/P1 badge in the UI. The agent
  never sees them.
- **Practice.** **Self-correction loop.** When `lint-artifact` returns ≥1
  P0 finding, automatically splice the findings into a system reminder and
  re-prompt the agent: *"Your output violated rules X, Y. Regenerate
  affected sections only — do not rebuild the page."* Cap at 2 retry passes
  to avoid runaway cost.
- **Where.** `apps/daemon/src/server.ts` — wrap the artifact-save handler in
  a check-and-revise loop. The skill body stays untouched.
- **Effort.** 1.5 days.
- **Validation.** Track P0 findings rate before/after. Target: <5% of
  artifacts ship with a P0 finding (currently unknown — instrument first).

### Q0-3. Visual self-critique with vision model

- **Problem.** The text linter cannot see things like *"the hero is
  centered but the rest of the page is left-aligned"* or *"the color
  palette feels muddy"*. Those are visual judgments.
- **Practice.** After generation, screenshot the artifact via the daemon's
  existing headless Chrome (used for PDF export), pass screenshot +
  `craft/anti-ai-slop.md` rubric to a vision-capable model with a strict
  RCAF judge prompt (Role / Context / Action / Format). Findings feed the
  same revision loop as Q0-2.
- **Critical caveat from research.** Pure closed text→image→text loops
  converge to ~12 dominant generic motifs ("visual elevator music"). To
  avoid this, anchor every loop with **at least one user-supplied reference**
  (Q1-1 below) and stop the loop after **N=2 iterations** unless the user
  explicitly asks for more. The human stays the discriminator.
- **Where.** New module `apps/daemon/src/critique/visual.ts`. Reuse the
  PDF export's headless Chrome. Use the user's existing agent if it
  supports vision (Claude, GPT-5, Gemini). For BYOK Topology C, fall back
  to direct Anthropic vision API.
- **Effort.** 4 days.
- **Validation.** Same A/B as Q0-1. Bonus: track time-to-acceptable as a
  health metric — a successful loop should reduce mean iterations per
  artifact.

### Q0-4. Multi-shot generation + LLM-as-judge

- **Problem.** Single-shot generation is a coin flip. Even with
  amplification, the first artifact may not match the brief.
- **Practice.** For high-stakes briefs (deck, landing page, design
  system), generate **K=3** variants in parallel, then run a
  **pairwise** judge (more reliable than pointwise per 2026 LLM-as-judge
  research) to rank them. Surface top-1 by default; expose all K in a
  "see other variants" drawer. **Bias mitigation:** run both orderings of
  each pair, ensemble across two judge prompts (one critique-leaning, one
  craft-leaning), aggregate.
- **Where.** New `apps/daemon/src/generation/multi-shot.ts` and
  `apps/daemon/src/judge/pairwise.ts`. K is configurable per skill via a
  new `od.generation.variants` field.
- **Cost note.** 3× tokens per generation. Default K=1; skills opt in
  via the protocol field. For Topology C (BYOK), warn the user
  upfront that multi-shot 3× their token bill.
- **Effort.** 4 days.
- **Validation.** Validate the judge against a golden human-rated set
  of 30 pairs. Require Cohen's κ ≥ 0.8 with a domain expert before the
  judge ships.

---

## Q1 — Personalization (compounds over time)

### Q1-1. Reference library / mood board

- **Problem.** Users have taste they cannot articulate but can recognise.
  The system needs **shown** references, not described ones.
- **Practice.** First-class reference library, scoped per project and per
  user. References are: (a) one or more `design-systems/*` favourites,
  (b) uploaded screenshots, (c) Figma node IDs (via the existing Figma MCP),
  (d) URLs whose preview the daemon snapshots. Brief amplifier (Q0-1)
  picks **K most-marginally-useful references** per brief — not all of
  them — using PIAST-style utility scoring (in 2026 a small-model
  approximation is enough; full Shapley is overkill).
- **Where.**
  - Storage: `~/.od/refs/<project>/` for files, SQLite table for metadata.
  - UI: a "References" panel beside the chat with drag-drop upload and a
    star-toggle on every `design-systems/*` card.
  - Daemon: `/api/refs` CRUD; reference manifest injected into amplified
    brief.
- **Effort.** 3 days for storage + UI + injection; +2 days for utility
  scoring.
- **Validation.** Qualitative — user reports "this feels like the stuff I
  pin on Pinterest" within one session.

### Q1-2. Taste memory (Mem0-style three scopes)

- **Problem.** Today every session starts cold. The system does not
  remember that this user **always** rejects purple gradients and **always**
  asks for tighter line-height.
- **Practice.** Three-scope memory layer (per Mem0 / 2026 agent-memory
  state-of-art):
  - **User-level** — durable taste preferences across all projects:
    *"prefers editorial typography, avoids high-contrast complementary
    palettes, likes asymmetric grids."*
  - **Project-level** — preferences locked into the current project:
    *"this project's tone is brutalist."*
  - **Session-level** — what changed in the last few iterations:
    *"user just rejected a navy-on-cream version."*
- **Where.** New `packages/taste-memory/` exporting a typed API. Backed by
  SQLite in the daemon (`~/.od/taste.sqlite`). Memory is **derived**, not
  hand-edited:
  - Every accepted artifact → +1 evidence for its tokens, layout shapes,
    type pairings.
  - Every rejected artifact / negative comment → −1 evidence + extracted
    rationale (small model summarises *why* into a short phrase).
  - Every comment-mode edit → strong signal (this is what they actually
    want changed).
- **Privacy.** Memory lives on the user's machine. Topology B does not
  upload it. Show the user a **memory inspector** UI where they can read,
  edit, and delete entries (1:1 with Mem0's transparency principle).
- **Effort.** 5 days for storage + ingestion + injection; +1 day for the
  inspector UI.
- **Validation.** After 10 sessions on the same project, the system's
  default brief amplification should match the user's accepted patterns
  ≥ 80% of the time without explicit prompting.

### Q1-3. Feedback capture as first-class UI

- **Problem.** Without explicit signal, taste memory degrades into "what
  the user did not delete," which is too noisy.
- **Practice.** Two cheap feedback affordances on every generation:
  - **Thumbs up/down** — one-click signal for the memory layer.
  - **"Why?"** — optional one-line free text (*"too busy", "love the
    type"*). Embedded with a small model and indexed for retrieval at
    next brief-amplification time.
- **Where.** Web app chat shell (artifact card footer) +
  `/api/feedback` route + table in the taste-memory store.
- **Effort.** 1.5 days.
- **Validation.** Feedback rate ≥ 30% on first 50 generations per user
  (instrumentation only — no UX nag).

### Q1-4. Style fingerprinting from screenshot/PDF

- **Problem.** S4 in `spec.md` is *"upload a screenshot, brand guide PDF,
  or Figma link, get a `DESIGN.md`"*. Today the `design-system` skill
  does this textually. With a vision model the extraction is dramatically
  better.
- **Practice.** Vision model extracts a **structured fingerprint** —
  dominant colors with hex + role guess, two-pair type system with
  inferred font families, spacing rhythm (4/8/12/16 vs. 5/10/20),
  motion vocabulary (none / subtle / playful), photography style. Output
  is a draft `DESIGN.md` that the user reviews and locks.
- **Where.** Augment `skills/design-system/SKILL.md` with a vision-pass
  step. New `apps/daemon/src/extract/fingerprint.ts`.
- **Effort.** 3 days.
- **Validation.** Compare extracted DESIGN.md tokens against the source
  brand on 5 known brands (Stripe, Linear, Notion, Figma, Apple). Token
  fidelity ≥ 80%.

---

## Q2 — Advanced loops (after Q0/Q1 are stable)

### Q2-1. Per-skill golden few-shot examples

- **Problem.** Generic agent has no concept of "what 'magazine-style deck'
  means **at this project**." A few high-quality examples in the prompt
  beat a paragraph of description.
- **Practice.** Each skill ships a `goldens/` folder with 2–3 curated
  HTML+screenshot pairs. The skill loader injects them as few-shot
  examples into the agent prompt. Goldens are versioned and replaceable —
  when a user accepts an artifact and rates it 5⭐, prompt them: *"Save
  as a golden for this skill?"*
- **Where.** Skills protocol — new `od.goldens` field. Daemon-side
  injection.
- **Effort.** 3 days.

### Q2-2. Critique skill in the loop, not as a destination

- **Problem.** The `critique` skill exists but is invoked only on demand
  ("review my landing page"). Its 5-dimension rubric is more rigorous
  than the linter and could power Q0-3.
- **Practice.** After Q0-3 ships the visual loop, replace the ad-hoc
  rubric with the `critique` skill's 5 dimensions
  (Philosophy / Hierarchy / Detail / Functionality / Innovation). The
  skill becomes the canonical taste rubric, not a separate report.
- **Where.** `apps/daemon/src/critique/visual.ts` calls
  `skills/critique/SKILL.md` rubric.
- **Effort.** 1 day (after Q0-3).

### Q2-3. Comment-mode → embedding-indexed change requests

- **Problem.** Comment-mode (`spec.md` §S1) gives surgical edits, but the
  request lives only in the active session. *"Last week I asked for less
  whitespace here — do that everywhere now."* is impossible.
- **Practice.** Index every comment-mode request by element type +
  context embedding. On future generations, retrieve the top-K relevant
  past comments and surface them as constraints in the amplified brief.
- **Where.** Extends Q1-2 (taste memory) with a vector store
  (`@libsql/sqlite-vector` or `vectra` — local, no service dependency).
- **Effort.** 4 days.

### Q2-4. "Designer mode" — explainable judge output

- **Problem.** When the system rejects a variant the user does not see
  why. Good judges teach taste.
- **Practice.** Pairwise judge (Q0-4) emits a one-line rationale per
  decision (*"Variant A wins: type pairing matches DESIGN.md;
  Variant B's accent count 7 vs. cap of 2"*). Render the rationale
  inline as a chip the user can click to see evidence. Improves trust
  and trains the user's eye.
- **Where.** Judge output schema; chat UI artifact card.
- **Effort.** 1.5 days (after Q0-4).

---

## Sequencing and effect

```
Week 1–2 (Q0):  brief amplifier → linter loop → visual critique → multi-shot
                These four together produce the single biggest quality jump.
                After this week the system is meaningfully harder to make
                ship slop, and the K=3 + judge mode handles "I want
                options" briefs.

Week 3–4 (Q1):  references → taste memory → feedback UI → style fingerprint
                After this period the system feels personal. By session
                ~10 it should default to the user's taste without being
                told. Memory inspector is the trust anchor.

Quarter Q3 (Q2): goldens, critique-in-the-loop, embedded comment recall,
                designer-mode rationale.
                These are compounding loops — they get better the longer
                the user uses the system, but they need Q0/Q1 to feed them.
```

## What the user will notice (in order)

1. **First session after Q0 ships.** "It's not just generating, it's
   *thinking*." The expanded-brief block surfaces the model's plan; the
   user can correct it before any output is generated.
2. **Third session.** "It stopped giving me purple gradients without my
   asking." (Linter loop + visual critique caught them.)
3. **Tenth session after Q1 ships.** "The first variant is usually the
   one I'd have picked." (Taste memory has trained on accept/reject
   signal.)
4. **One-month mark with Q2.** "I commented on whitespace once, it
   remembered for the whole project." (Embedded comment recall.)

## Anti-patterns to avoid (drawn from research)

- **Closed-loop visual self-critique without a user reference** →
  converges to "visual elevator music" (cell.com 2025 study). Always
  anchor with at least one user-supplied reference and cap loops at N=2.
- **Pointwise scoring** → drifts run-to-run. Use pairwise comparison with
  both orderings and judge ensembles.
- **Generic NL critique back to the agent** → research shows it's largely
  ineffective for refinement. Critique must be **specific, structured,
  and tied to a checkable rule** (which is what the linter already is —
  Q0-2 just connects it to the agent).
- **Auto-saving everything to memory** → noise drowns signal. Memory must
  be derived from explicit accept/reject + comment-mode events, never
  from "user did not click delete."
- **Hidden memory** → users distrust black boxes. Memory inspector is
  not optional; it is the trust contract.

## References

- Cell Patterns (2025) — "Autonomous language-image generation loops
  converge to generic visual motifs"
- arxiv 2508.02994 — "When AIs Judge AIs: Agent-as-a-Judge Evaluation"
- 2026 LLM-as-judge guides (evidently.ai, patronus.ai, eugene yan) —
  pairwise > pointwise, position/verbosity/self-preference/authority bias
- Mem0 — "State of AI Agent Memory 2026" (three-scope architecture,
  user/session/agent levels, transparency principle)
- PIAST (arxiv 2512) — marginal-utility-driven example curation
- arxiv 2506.06658 — "Self-Improving Loops for Visual Robotic Planning"
  (anchored vs. unanchored loops)
- OWASP Prompt Injection Cheat Sheet — feedback-injection guards
