# Taste memory — T2.2 status

Mem0-style three-scope memory layer that learns the user's taste from
their accept / reject / star events and injects it into every system
prompt as **probabilistic defaults** (per `docs/prompt-engineering.md`
Layer 6 — never hard constraints).

## What's shipped (this commit)

**Schema**

`taste_signals` table in [`db.ts`](db.ts) migration:

```
id, scope, project_id, session_id, subject, polarity (+1/-1),
source, payload_json, created_at
```

Three scoped indexes for the read-time aggregator. Privacy: lives in
local SQLite; Topology B does not upload it.

**Storage layer**

[`taste-memory.ts`](taste-memory.ts):

- `recordTasteSignal(db, input)` — validated insert. Rejects bad
  scope / source / polarity / scope-id mismatch.
- `aggregateUserTaste(db)`, `aggregateProjectTaste(db, projectId)`,
  `aggregateSessionTaste(db, sessionId)` — sum polarity per subject
  with a 30-day half-life decay; rank by absolute score; return
  `TasteAggregate[]` with confidence labels (high ≥10 consistent,
  medium ≥5, low 1–4).
- `normaliseSubject()` — canonicalises kind prefixes and color hex
  values so different spellings of the same signal aggregate.
- Inspector helpers: `listTasteSignals`, `deleteTasteSignal`,
  `clearTasteScope`.

**Hooks (signal sources wired this commit)**

| Source         | Where                     | Polarity | Scope    | Subject example |
|---|---|---|---|---|
| `judge`        | post-run judge parser     | +1       | user     | `judge-axis:layout` |
| `lint`         | post-run lint, P0 only    | -1       | project  | `slop-rule:ai-default-indigo` |
| `reference`    | references toggle endpoint | ±1      | project  | `design-system:stripe` |

Future hooks (deferred):

- `auto-revise` — when the user clicks Auto-revise on a critique or
  lint card. The agentMessage contains the rule ids; we can record
  one negative signal per rule.
- `comment` — when the user drops a comment-mode edit. The selector
  + tag are signal candidates; the comment text needs a short LLM
  pass to extract `kind:value` subjects.
- `feedback` — explicit thumbs-up/down (T2.3 work item).

**Prompt injection**

[`prompts/system.ts → renderTasteBlock`](prompts/system.ts) emits a
`## Learned user preferences (derived from past sessions, may be
wrong)` block when any scope has aggregates above the threshold. The
load-bearing phrases (verified by
[`tests/taste-prompt.test.ts`](../tests/taste-prompt.test.ts)):

- "**probabilistic** summary"
- "may be wrong"
- "the brief wins"
- "project-level entries override user-level entries"
- "session-level entries override both"

Each row uses **prefer** / **avoid** (derived from polarity sign) and
shows confidence label + count so the model can weight rows.

**HTTP endpoints**

```
GET    /api/taste/aggregate?scope=user
GET    /api/taste/aggregate?scope=project&projectId=…
GET    /api/taste/aggregate?scope=session&sessionId=…
GET    /api/taste/signals?scope=…&id=…&limit=…
POST   /api/taste/signals          (manual record / inspector edit)
DELETE /api/taste/signals/:id
DELETE /api/taste/scope/:scope?id=…
```

## What's NOT shipped (UX follow-up)

The **memory inspector UI** is the trust contract — without it users
distrust the memory layer and turn it off (or never adopt it). The
data layer is ready; the UI is not.

### Inspector requirements

1. **List view** — show all rows for a chosen scope, most-recent
   first. Each row: subject, polarity (icon + color), source, time.
2. **Per-row delete** — single-click remove (no confirmation; users
   can recreate signals trivially by acting again).
3. **Per-scope clear** — danger button with confirm dialog.
4. **Aggregated view** — show the derived profile (what the agent
   actually sees). This is the most-trusted surface; users should
   land on this view first.
5. **Privacy chip** — explicit "this never leaves your machine"
   wording near the top.

### Surface placement

Best fit is a new tab in the existing settings dialog, alongside
"BYOK" and the agent picker. It is **not** project-specific (since
user-level memory is global), but the project filter inside the tab
lets users scope what they're inspecting.

## Anti-patterns to avoid (drawn from research)

- **Auto-saving every event** — noise drowns signal. Memory must be
  derived only from explicit accept / reject / comment-mode events,
  never from "user did not click delete." See Mem0's transparency
  principle.
- **Hidden memory** — distrust collapse. The inspector is mandatory.
- **Memory as constraint** — the model treats high-confidence
  entries as hard rules and ignores explicit briefs that contradict.
  The Layer 6 framing is verified by the `taste-prompt.test.ts`
  suite; do not edit it without updating the tests.

## Tests

- [`tests/taste-memory.test.ts`](../tests/taste-memory.test.ts) — 17
  cases for storage, aggregation, scope isolation, half-life decay,
  confidence labels, inspector helpers.
- [`tests/taste-prompt.test.ts`](../tests/taste-prompt.test.ts) — 6
  cases asserting injection, framing, layering, confidence display.
