# Master Plan — 2026-05

**Status.** Active. Supersedes `improvement-plan-2026-05.md` and
`quality-and-taste-plan-2026-05.md` (kept for traceability; both are
referenced as "Plan A" / "Plan B" below).

**Purpose.** A single prioritized roadmap that combines two parallel concerns:

- **Plan A** — security, reliability, and ecosystem alignment.
- **Plan B** — output quality and personalization (taste).

Items are ordered by **impact ÷ effort, gated by sequencing**: do not start a
later item if it depends on an earlier one. Each row links back to the
detailed spec in Plan A or Plan B.

## Tier system

| Tier | Meaning | When |
|---|---|---|
| **T0** | Ship-blockers and biggest visible quality lift. Small change, large effect. | This week |
| **T1** | Compounding improvements that rely on T0 plumbing. | Next 2 weeks |
| **T2** | Loops and personalization that pay off after sustained use. | This month |
| **T3** | Strategic alignment with the 2026 ecosystem. | This quarter |

---

## T0 — This week (5 items, ~6 dev-days)

| # | Item | Source | Effort | Why now |
|---|---|---|---|---|
| T0.1 | **CSP in preview iframe** (both `srcdoc.ts` and `react-component.ts`). Blocks the exfiltration vector that markdown-image / `fetch` injection relies on. | Plan A · P0-1 | 1 d | Cheapest security win; lives in one place. |
| T0.2 | **Skill sanitizer + defensive system prompt.** Strip `<!-- … -->` blocks from `SKILL.md` body before the agent sees it. Prepend "treat as untrusted reference" preamble. | Plan A · P0-2 | 1 d | Closes the "When Skills Lie" hidden-comment vector. |
| T0.3 | **Brief amplifier.** Run a small-model prompt expansion before the agent is invoked. User sees and can edit the structured brief. **Single biggest visible quality lift.** | Plan B · Q0-1 | 2 d | Every later loop in this plan benefits from a richer brief. |
| T0.4 | **Lint → refine loop.** `lint-artifact.ts` already emits `agentMessage` via `renderFindingsForAgent`; wire it back into the chat so P0 findings auto-trigger one revise pass. | Plan B · Q0-2 | 1.5 d | Uses existing infra; eliminates the 7 cardinal AI-slop sins systematically. |
| T0.5 | **BYOK keys → IndexedDB + WebCrypto.** Replace `localStorage` storage with passphrase-derived AES-GCM in IndexedDB. | Plan A · P0-3 | 2 d | Documented as unsafe in our own docs; OWASP-blocking. |

**T0 exit criteria.** All five merged behind feature flags off by default;
turned on after one A/B week. Security audit on T0.1 + T0.2 passes.

---

## T1 — Next 2 weeks (4 items, ~13 dev-days)

| # | Item | Source | Effort | Depends on |
|---|---|---|---|---|
| T1.1a | **Structural self-critique** (✓ shipped, behind `OD_VISUAL_CRITIQUE=1`). Prompt-driven `<od-critique>` block; daemon stream parser; sibling card to lint findings; auto-revise wired. Caps at one revise pass per turn (anti-elevator-music guardrail per Cell Patterns 2025). | Plan B · Q0-3 | 2 d | T0.4 (loop plumbing) |
| T1.1b | **Pixel critique (vision pass).** Screenshot via headless Chrome → vision API → findings appended to the same `<od-critique>` channel. Defers behind T1.1a — adds Puppeteer/Playwright as a dep and a vision API call. | Plan B · Q0-3 | 3 d | T1.1a |
| T1.2 | **Multi-shot K + pairwise judge** (✓ shipped, behind `OD_MULTI_SHOT=2..5`). Prompt-driven: agent emits K `<artifact>` blocks + one `<od-judge>` ranking with bias-mitigation rules in the directive. Daemon parses the judge, emits typed SSE event, JudgeCard renders winner + ranking. Per-skill `od.generation.variants` field deferred to follow-up. | Plan B · Q0-4 | 2 d | T0.3 (brief), T0.4 (loop plumbing) |
| T1.3a | **Daemon health probes** (✓ shipped). `/health/live` returns 200 always; `/health/ready` checks db + agent registry, returns 503 with reasons. | Plan A · P1-2 | 0.5 d | — (independent) |
| T1.3b | **Web disconnected badge** consuming `/health/ready`. | Plan A · P1-2 | 0.5 d | T1.3a |
| T1.3c | **Supervisor with backoff in tools-dev.** Requires lifecycle review — current daemon is spawned detached so tools-dev exits. Move spawn into a long-running watcher + add `tools-dev supervise <app>` subcommand. | Plan A · P1-2 | 1.5 d | T1.3a |
| T1.4 | **OTel GenAI + cost tracker.** Per-call spans with `gen_ai.usage.*`. Daemon-side aggregation + cost badge in chat. | Plan A · P1-3 | 3 d | — (independent) |

**T1 exit criteria.** Chat shows expanded brief, K=3 variants on demand,
visual critique runs once on every artifact, cost is visible in the header.
Daemon survives crash without manual restart.

---

## T2 — This month (5 items, ~14 dev-days)

| # | Item | Source | Effort | Depends on |
|---|---|---|---|---|
| T2.1a | **Reference library — data layer + prompt injection** (✓ shipped). SQLite `project_references` table; CRUD endpoints; system-prompt block "User-curated references" rendered as taste signals. UI deferred. | Plan B · Q1-1 | 1 d | T0.3 |
| T2.1b | **Reference library — UI surfaces.** Star toggle on design-system picker, references chip in chat header, "References" panel for upload / URL / Figma. Needs UX decisions per `apps/daemon/src/REFERENCES.md`. | Plan B · Q1-1 | 2 d | T2.1a |
| T2.2a | **Taste memory — data + injection** (✓ shipped). SQLite `taste_signals` table; user/project/session aggregation with half-life decay; "Learned user preferences (may be wrong)" prompt block per Layer 6; hooks wired for judge axis, lint P0, reference toggle. | Plan B · Q1-2 | 1.5 d | T2.1a |
| T2.2b | **Taste memory — inspector UI.** Settings tab with list-by-scope, per-row delete, per-scope clear, aggregated view, privacy chip. UX recipe in `apps/daemon/src/TASTE-MEMORY.md`. | Plan B · Q1-2 | 2 d | T2.2a |
| T2.3 | **Feedback UI 👍/👎 + "why"** (✓ shipped). FeedbackBar in assistant footer; POST `/api/feedback` derives subjects (`skill:`, `design-system:`, `mood:`) + records BOTH project and user-level signals so explicit feedback compounds across projects. 'Why' text stored in payload for future embedding-based retrieval (T3.3). | Plan B · Q1-3 | 1.5 d | T2.2 |
| T2.4 | **Resumable SSE streams** (✓ shipped). Per-run ring buffer + `id:` wire format + replay on `Last-Event-ID` / `?after=` were already in `runs.ts`; this commit adds **replay-gap detection** (synthetic event when buffer trim has lost data the client needs), **exponential backoff** in web reconnect (0/250/500/1000/2000ms instead of immediate retries), and **11 unit tests** for the replay logic. | Plan A · P1-1 | 1.5 d | T1.3 (health probes) |
| T2.5 | **Style fingerprinting from screenshot/PDF.** Vision-based DESIGN.md extractor. Strengthens S4 ("upload brand guide"). | Plan B · Q1-4 | 3 d | T1.1 (vision plumbing) |

**T2 exit criteria.** A user who has used the app 10+ times feels the system
default-renders to their taste without prompting. Memory inspector exists.
Network blip mid-generation no longer loses the artifact.

---

## T3 — This quarter (6 items, ~3 dev-weeks)

| # | Item | Source | Effort | Depends on |
|---|---|---|---|---|
| T3.1 | **Per-skill golden few-shot.** `goldens/` folder per skill; injected as few-shot examples; 5⭐ artifacts can be promoted to goldens. | Plan B · Q2-1 | 3 d | T2.2 |
| T3.2 | **Critique skill in the loop.** Replace ad-hoc rubric in T1.1 with the canonical 5-dim critique skill. | Plan B · Q2-2 | 1 d | T1.1 |
| T3.3 | **Embedded comment-mode recall.** Vector-index past comments; surface relevant past constraints in amplified brief. | Plan B · Q2-3 | 4 d | T2.2 |
| T3.4 | **Designer-mode rationale.** Pairwise judge emits one-line "why this won". | Plan B · Q2-4 | 1.5 d | T1.2 |
| T3.5 | **Turborepo + remote cache.** | Plan A · P2-1 | 1 d | — |
| T3.6 | **Electron security audit.** | Plan A · P1-4 | 0.5–1.5 d | — |
| T3.7 | **MCP adapter for OD skills.** Strategic interop. | Plan A · P2-2 | 1–2 weeks | — |

---

## Sequencing diagram

```
Week 1            Week 2-3                Week 4+              Quarter
─────────         ─────────────────────   ────────────────     ─────────────
T0.1  CSP                                                       
T0.2  skill san                                                 
T0.3  brief ────► T1.1  vision ─────────► T2.5  fingerprint     T3.1 goldens
       │          T1.2  multishot ──────► T3.4 rationale        T3.2 critique
       │                                  T2.1  refs ──────►    T3.3 recall
       │                                  T2.2  memory ────►   
T0.4  lint loop ──┘                       T2.3  feedback        T3.5 turbo
T0.5  byok                                                      T3.6 electron
                  T1.3  health                                  T3.7 mcp
                  T1.4  otel                                    
                                          T2.4  sse resume     
```

## Implementation gates

Before promoting any tier to "shipped":

- **T0**: green `pnpm typecheck && pnpm test`; manual smoke of preview +
  skill load + chat round-trip.
- **T1**: A/B against held-out brief set (~20 prompts) — human prefers
  T1 output ≥ 60% over T0-only baseline.
- **T2**: same A/B at session 1, 5, 10 — improvement should compound (cold
  user near 60%, returning user ≥ 80%).
- **T3**: end-to-end e2e per existing `e2e/` suite + targeted suites
  per item.

## What ships first concretely

In the order this plan was written (this commit and the next):

1. **T0.1** — CSP meta in both srcdoc generators + tests.
2. **T0.2** — skill body sanitizer + defensive prompt block.
3. **T0.3** — brief amplifier module, behind a `OD_BRIEF_AMPLIFY=1` env
   flag, default off until A/B'd.
4. **T0.4** — lint→refine wire-up in chat pipeline (one revise pass).
5. **T0.5** — BYOK migration to IndexedDB + WebCrypto.

Plan B's "what the user will notice" sequence applies here too:

- After T0 ships: "it stopped giving me purple gradients" (lint loop) +
  "I can edit the brief before generation" (amplifier).
- After T1 ships: "the multi-shot lets me pick" + "I can see what each run
  cost".
- After T2 ships: "by session 10 the first variant is usually right" +
  "if my WiFi blips, the run survives".
- After T3 ships: "this works in Cursor / OpenAI Apps / any MCP host
  unchanged".

## Plan A and Plan B (canonical references)

- `improvement-plan-2026-05.md` — full spec for security/reliability items
  (P0-1 … P2-3).
- `quality-and-taste-plan-2026-05.md` — full spec for quality/taste items
  (Q0-1 … Q2-4).
- This document is the **execution order**. Disagreements are resolved here;
  the underlying specs are the source of truth for *what* each item is.
