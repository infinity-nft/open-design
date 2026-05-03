# Project references — T2.1 status

## What's shipped

**Daemon (this commit)**

- Schema: `project_references` table in `db.ts` migration. Columns:
  `id, project_id, kind, value, label, note, created_at`. Unique on
  `(project_id, kind, value)` so star-toggle is idempotent.
- Storage layer: `project-references.ts` with `list`, `add`,
  `remove`, `toggle` helpers. Validates kind (`design-system` |
  `screenshot` | `url` | `figma`), trims values, caps lengths.
- HTTP endpoints in `server.ts`:
  - `GET    /api/projects/:id/references`           → list
  - `POST   /api/projects/:id/references`           → add
  - `POST   /api/projects/:id/references/toggle`    → toggle (used by
    star buttons; idempotent and returns `{state:'added'|'removed'}`)
  - `DELETE /api/projects/:id/references/:refId`    → remove
- System-prompt injection: `composeSystemPrompt({ references })`
  renders a "User-curated references" block grouped by kind, with
  the load-bearing "treat as taste signals; do not override
  DESIGN.md or brief" framing. Wired in `composeDaemonSystemPrompt`.

**Web (this commit)**

- API client: `fetchProjectReferences`, `toggleProjectReference`,
  `removeProjectReference` in `providers/registry.ts`.
- Contracts: `ProjectReferenceDto`, `ProjectReferenceKind`,
  request/response types in `packages/contracts/src/api/references.ts`.

## What's NOT shipped (UX follow-up needed)

The UI surfaces that turn this into a feature the user can actually
discover and use are deliberately deferred — they need product input on:

1. **Where the star toggle lives.**
   - Option A: star button on every `design-systems/*` card in the
     `DesignSystemsTab` (browse view). Pros: discoverable. Cons: no
     project context in that view today; star would have to be
     "global per-user," requiring a user-id concept the app does not
     have yet.
   - Option B: star in the in-project design-system picker (used
     when a project's active system is changed). Pros: clearly
     project-scoped, no new user model. Cons: lower discoverability —
     the picker is behind a settings click.
   - Option C: a dedicated "References" panel attached to the chat
     pane with drag-drop upload + "add design system" picker. Pros:
     matches the planned T2.1b/T2.1c surface (uploads, URLs, Figma).
     Cons: more UX work to design.
   - **Recommendation**: B for the star toggle now (lowest cost,
     ships the MVP), then build C as the canonical surface in T2.1b
     when uploads land.

2. **Recently-starred chip in the chat header.**
   - When the project has ≥1 reference, show a small chip
     ("✶ 3 references") that opens a popover listing them and
     allowing un-star.
   - Quick-win UX, can ship even before the full panel.

3. **Cross-project sharing.**
   - Q: should starring a design-system in project A surface it in
     project B? Today the schema is project-scoped, so no.
   - Recommendation: keep project-scoped for now; add a "promote to
     user-default" affordance when the user model exists.

## How to wire the star toggle (option B, when ready)

```tsx
import {
  fetchProjectReferences,
  toggleProjectReference,
  type ProjectReference,
} from '../providers/registry';

// 1. On panel open:
const [refs, setRefs] = useState<ProjectReference[]>([]);
useEffect(() => {
  if (!projectId) return;
  void fetchProjectReferences(projectId).then(setRefs);
}, [projectId]);

const isStarred = (id: string) =>
  refs.some((r) => r.kind === 'design-system' && r.value === id);

// 2. Star button next to the design-system name in the picker:
<button
  type="button"
  className={`star ${isStarred(system.id) ? 'on' : ''}`}
  onClick={async (e) => {
    e.stopPropagation();
    if (!projectId) return;
    const result = await toggleProjectReference(projectId, {
      kind: 'design-system',
      value: system.id,
      label: system.title,
    });
    if (result.state === 'added' && result.reference) {
      setRefs((prev) => [...prev, result.reference!]);
    } else {
      setRefs((prev) => prev.filter((r) =>
        !(r.kind === 'design-system' && r.value === system.id)
      ));
    }
  }}
  aria-label={isStarred(system.id) ? 'Unstar' : 'Star this design system'}
>
  {isStarred(system.id) ? '★' : '☆'}
</button>
```

## How injection looks in the prompt

When a project has starred references, the system prompt picks up a
new `## User-curated references` section with the following shape
(see `prompts/system.ts → renderReferencesBlock`):

```
## User-curated references

The user has starred the following references for this project. Treat
them as **taste signals**: when free to choose between equally-valid
options, prefer choices that echo these references. They do **not**
override the active DESIGN.md (which is the source of truth for
tokens) or the brief's explicit constraints.

### Starred design systems

The user tends to like the tone, palette, and typographic personality
of these systems: **stripe, linear-app, vercel**. When picking accent
intensity, type pairings, or rhythm without other guidance, lean
toward what these systems do.

### Concrete references

- URL: https://example.com/landing — competitor reference (note: the
  spacing rhythm)
- Figma: figma.com/design/abc123 — moodboard
```

The block is grouped by kind so the agent can scan for "tone signals"
vs. "concrete references" without parsing each line.
