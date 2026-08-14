# CoBoard — Engineering Rules

| Field | Value |
|---|---|
| Document type | Enforceable ruleset |
| Version | 1.0 |
| Status | Binding on all contributors |
| Applies to | `apps/web`, `apps/server`, `packages/shared`, all documentation |
| Companion docs | [`CLAUDE.md`](./CLAUDE.md), [`docs/01-PRD.md`](./docs/01-PRD.md), [`docs/02-FLOWS.md`](./docs/02-FLOWS.md), [`docs/03-TRD.md`](./docs/03-TRD.md), [`docs/04-IMPLEMENTATION-PLAN.md`](./docs/04-IMPLEMENTATION-PLAN.md) |

---

# 1. How to use this document

## 1.1 What this is

`CLAUDE.md` tells you **how to work in this repository**. This document tells you **what you are not allowed to do**, and what you must do, in a form that can be cited in a code review without argument.

Every rule has a stable ID. When you reject a pull request, cite the rule ID. When you disagree with a rule, do not quietly violate it — use the exception process in §20.

## 1.2 Rule ID scheme

```
R-<DOMAIN>-<NNN>
```

| Domain | Section | Covers |
|---|---|---|
| `R-PREC` | §2 | Precedence and conflict resolution |
| `R-ARCH` | §3 | Architecture and module boundaries |
| `R-SKILL` | §4 | Design-skill usage and zoning |
| `R-CANVAS` | §5 | Canvas rendering engine |
| `R-COORD` | §6 | Coordinate spaces |
| `R-SYNC` | §7 | Sync engine and wire protocol |
| `R-CONV` | §8 | Conflict resolution and convergence |
| `R-UNDO` | §9 | Undo and redo |
| `R-STATE` | §10 | Client state management |
| `R-SEC` | §11 | Security |
| `R-UI` | §12 | Visual and interaction design |
| `R-MOTION` | §13 | Animation and motion |
| `R-A11Y` | §14 | Accessibility |
| `R-PERF` | §15 | Performance |
| `R-TEST` | §16 | Testing |
| `R-GIT` | §17 | Version control and review |

IDs are **stable and never reused**. If a rule is withdrawn it is marked `WITHDRAWN` in place, keeping its number, with the date and reason.

## 1.3 Severities

| Severity | Meaning | Enforcement |
|---|---|---|
| **Blocking** | Violating this ships a broken, insecure, or unusable product. | CI fails, or the reviewer must reject. No exceptions without written sign-off from the engineering lead. |
| **Required** | Violating this produces a defect or a measurable quality regression. | Reviewer must reject. Exception requires a recorded waiver (§20). |
| **Recommended** | Best practice. Deviating needs a reason, not permission. | Reviewer raises it; author may justify in the PR thread. |

## 1.4 Citing a rule in review

Write the ID and the specific line:

> `R-SYNC-011` — `Outbox.onNack` re-queues here (`apps/web/src/features/sync/Outbox.ts:64`). Nacked ops must be dropped, not retried.

Do not write "this feels wrong". Find the rule, or propose a new one.

## 1.5 Source annotations

Rules derived from a specification carry the source in brackets, e.g. `[PRD §7.4]`, `[TRD §5.4]`, `[FLOWS §15.1]`. Where a rule exists because a specification and a design skill disagreed, it carries the conflict ID `[C-3]` and is explained in §2.

---

# 2. Precedence — the constitutional section

This is the most important section in the document. Read it before you write a line of UI code.

## 2.1 Why this section exists

This project is governed by **three specifications** and **six design skills**. They do not agree with each other. Left unresolved, every engineer resolves each contradiction differently and the product becomes visually and architecturally incoherent.

The specifications are contracts. The skills are craft libraries. When they collide, the ladder below decides, and §2.3 records the eight specific collisions already identified so nobody re-litigates them in a PR thread.

## 2.2 The precedence ladder

**R-PREC-001** `Blocking` — When two sources of guidance conflict, resolve in this order. Higher tiers win absolutely; a lower tier never overrides a higher one, no matter how strongly worded.

| Tier | Authority | Examples |
|---|---|---|
| **1** | **Security and data integrity** | Zero committed-op loss `[PRD §7.3]`, server-side authorization `[PRD §7.4]`, persist-before-ack `[TRD D-14]` |
| **2** | **Explicit specification requirements** | Requirement IDs `FR-*`, performance budgets `[PRD §7.1]`, design tokens `[PRD §15]`, the stack table `[TRD §1.1]` |
| **3** | **Accessibility** | `[PRD §7.5]`, WCAG contrast floors |
| **4** | **Design-skill guidance** | The six skills in §4 |
| **5** | **Individual taste** | Your preference |

**R-PREC-002** `Blocking` — A design skill may **fill a gap** in the specifications. It may never **overrule** a specification. If the PRD, FLOWS or TRD states a value, that value stands.

**R-PREC-003** `Required` — If you find a conflict not listed in §2.3, stop and escalate before choosing. Add the resolution to §2.3 in the same pull request. Silently picking a side is the violation, not picking the "wrong" side.

**R-PREC-004** `Required` — Where the specifications themselves are internally inconsistent, treat the defect register in §2.4 as authoritative. Do not patch the source specification files — they are preserved as delivered.

## 2.3 The eight resolved conflicts

Each was found by reading the six skills in full against the three specifications. Each names the losing side explicitly.

---

### C-1 — Typeface

**R-PREC-010** `Blocking` — `Inter` is the typeface for every one of the 22 screens.

| Side | Position |
|---|---|
| `[PRD §15]` | `--font-sans: Inter, system-ui, -apple-system, sans-serif` — "All UI" |
| `high-end-visual-design` §2 | "**Banned Fonts:** Inter, Roboto, Arial, Open Sans, Helvetica" |
| `gpt-taste` §1 | "Satoshi, Cabinet Grotesk, Outfit, or Geist. **NEVER Inter**" |
| `design-taste-frontend` §0.D | Lists "Inter + slate-900" among the LLM defaults to reach past |

**Resolution:** PRD §15 is Tier 2; the skills are Tier 4. **Inter wins.** The three font bans are formally overridden and are void in this repository.

**Recorded deviation, not adopted:** a display face (e.g. Clash Display, PP Editorial New) for S-01 marketing headings only. This is a reasonable idea and would satisfy the skills, but PRD §15 says "All UI". It requires explicit sign-off before adoption and is tracked as an open question in `docs/04-IMPLEMENTATION-PLAN.md` §8.P. **Do not implement it on your own initiative.**

---

### C-2 — Icon family

**R-PREC-011** `Required` — Icons come from `@phosphor-icons/react`, one family, no exceptions.

| Side | Position |
|---|---|
| `ui-ux-pro-max` | "Use SVG icons (Heroicons, Lucide, Simple Icons)" |
| `design-taste-frontend` §3.C | Priority order Phosphor → Hugeicons → Radix → Tabler. "**Discouraged:** `lucide-react`" |
| `high-end-visual-design` §2 | "**Banned Icons:** Standard thick-stroked Lucide, FontAwesome, or Material Icons" |
| Specifications | **Silent** |

**Resolution:** The specs are silent, so this is a Tier 4 decision — a genuine gap the skills fill. Phosphor is the only choice that satisfies all three skills at once: it is `design-taste-frontend`'s first preference, its Light/Regular weights meet `high-end-visual-design`'s "ultra-light, precise lines" requirement, and `ui-ux-pro-max`'s actual requirement is a consistent SVG set rather than emoji — which Phosphor satisfies. **Lucide loses.**

---

### C-3 — Animation library

**R-PREC-012** `Blocking` — CSS is the default animation mechanism. Framer Motion is permitted only in the marketing and dashboard chunks. GSAP is not a dependency of this project.

| Side | Position |
|---|---|
| `framer-motion-animator` | Framer Motion / `motion/react` for everything |
| `gpt-taste` §5 | "You must write real GSAP (`@gsap/react`, `ScrollTrigger`)" |
| `emil-design-eng` | "CSS animations beat JS under load"; FM's `x`/`y` are not hardware-accelerated |
| `[TRD §1.1]` | Stack table names **no** animation library |

**Resolution:** See §13 for the full motion policy. In summary — CSS transitions, custom cubic-béziers, `@starting-style` and WAAPI are the default everywhere; Framer Motion is lazy-loaded into the marketing and dashboard chunks only and is banned from the board route; **GSAP is not adopted**. `gpt-taste`'s scroll-pinning, scrubbing, image scale-fade and card-stacking patterns are reproduced with `IntersectionObserver` and CSS scroll-driven animations. **`gpt-taste`'s GSAP mandate loses**, on Tier 2 grounds (C-4) and Tier 1 grounds (the 60 fps canvas requirement).

---

### C-4 — Bundle budget

**R-PREC-013** `Blocking` — The PRD §7.1 bundle budgets are hard CI gates. No animation or design dependency may breach them.

`[PRD §7.1]` sets initial JS ≤ 250 KB gzipped and the board route chunk ≤ 200 KB gzipped. GSAP + ScrollTrigger is roughly 50 KB; Framer Motion is roughly 40 KB. Carrying both, as the skills collectively demand, consumes over a third of the initial budget for decoration.

**Resolution:** Budgets are Tier 2 and binding. Enforced by `R-PERF-020` and `R-PERF-021`.

---

### C-5 — Skill scope

**R-PREC-014** `Blocking` — Design skills apply only within their assigned zone (§4.2). Applying landing-page grammar to product UI is a rule violation, not a matter of taste.

`design-taste-frontend`'s own header reads: *"Landing pages, portfolios, and redesigns. **Not dashboards, not data tables, not multi-step product UI.**"* `gpt-taste` is entirely landing-page oriented — AIDA structure, hero architecture, bento grids, `picsum.photos` imagery, infinite marquees.

CoBoard is approximately 90% product UI. Two of the six skills exclude themselves from most of this application **by their own terms**.

**Resolution:** The zoning map in §4.2 is binding. This is not a downgrade of those skills — it is applying them where they are designed to work.

---

### C-6 — Motion versus 60 fps

**R-PREC-015** `Blocking` — The canvas is a no-decoration zone. `emil-design-eng`'s frequency framework governs all motion decisions.

| Side | Position |
|---|---|
| `high-end-visual-design` §5 | Heavy `backdrop-blur`, 800 ms `blur-md` fade-ups on scroll entry |
| `gpt-taste` §5 | GSAP pinning, scrubbing, card stacking, `scale` transitions on scroll |
| `emil-design-eng` | Seen 100+ times/day → **no animation, ever** |
| `[PRD G-3, §7.1]` | ≥ 55 fps sustained with 5,000 objects; ≤ 16 ms input-to-pixel |

**Resolution:** `emil-design-eng` is the only motion skill whose philosophy agrees with the PRD, and it agrees precisely: a whiteboard's core interactions are performed hundreds of times per session, which is exactly the frequency band where it prescribes no animation at all. The maximalist scroll-choreography of the other two skills **loses** inside the product, and is confined to S-01.

---

### C-7 — Colour tokens

**R-PREC-016** `Blocking` — `[PRD §15]` is the complete and only colour source for product UI. The presence and sticky-note palettes are frozen.

Running the `ui-ux-pro-max` design-system generator against this product returns:

```
Primary #0D9488 (teal) · Secondary #14B8A6 · CTA #F97316 (orange)
Background #F0FDFA · Text #134E4A · Typography: Plus Jakarta Sans
```

PRD §15 mandates `--color-accent: #4F46E5` (indigo), `--color-bg-canvas: #FAFAFA`, `--color-text-primary: #18181B`, and Inter.

**Resolution:** PRD §15 wins on Tier 2. The generator's colour and typography output is **advisory only** — see `R-SKILL-020`. Its UX, accessibility, stack and anti-pattern output **is** adopted, because the specs are silent there.

The **12-colour presence palette** and the **8-colour sticky palette** are additionally frozen by `R-UI-013` and `R-UI-014` because they carry protocol meaning: a user's presence colour is assigned server-side and must render identically for every participant, and a sticky's colour is a persisted object property.

---

### C-8 — Tailwind version

**R-PREC-017** `Blocking` — Tailwind CSS **3.x**. Not v4.

`[TRD §1.1]` specifies Tailwind 3.x. `design-taste-frontend` §3.A defaults to Tailwind v4 and gives v4-specific PostCSS instructions (`@tailwindcss/postcss`, the Vite plugin, `@theme` blocks).

**Resolution:** TRD §1.1 is Tier 2. **Tailwind 3.x wins.** PRD §15 tokens are mapped through `theme.extend` in `tailwind.config.ts`. All v4-specific guidance in `design-taste-frontend` is void here.

---

### Secondary resolutions

**R-PREC-018** `Required` — **Em-dashes.** `design-taste-frontend` §9.G bans the em-dash as an AI tell. `[PRD §8.2]` canonical copy strings must ship verbatim. Resolution: PRD copy ships **exactly as written**, em-dashes included. The ban applies only to newly authored copy that the PRD does not specify.

**R-PREC-019** `Required` — **Emoji in the UI.** FLOWS §14.4 shows a `👁 View only` badge and §10.1 shows a `🔗` link icon. These appear inside illustrative ASCII layout sketches, not in the §8.2 canonical copy table. Resolution: render them as Phosphor glyphs (`Eye`, `Link`) per `R-UI-011`. No emoji is used as an icon anywhere in the product.

## 2.4 Specification defect register

Defects found in the source specifications during planning. The source files in `docs/` are preserved **as delivered** and are not edited. These entries are the authoritative resolution.

| # | Defect | Location | Resolution |
|---|---|---|---|
| **D-1** | `FR-BOARD-041` is referenced but does not exist. Board requirements stop at `FR-BOARD-009`. | `docs/01-PRD.md` line 183, inside `FR-AUTH-005` | The referenced behaviour — session expiry while a board is open — is fully specified as **`E-17`** in `docs/02-FLOWS.md` §12.5: keep the socket alive, refresh silently, and on failure show a banner rather than ejecting the user. Treat `E-17` as the binding requirement. Implemented in Phase 7 and Phase 14. |
| **D-2** | `FR-CANVAS-017` contradicts itself: the heading is marked `[P1]` while the title and body say `[P2]` and "Deferred. Do not build." | `docs/01-PRD.md` line 370 | The body is unambiguous and is a scope instruction. Treat grouping as **P2, deferred**. It appears in the deferred backlog, not in any phase. |
| **D-3** | `FR-BOARD-012` appears in §0 as an illustrative example of an ID, not as a real requirement. | `docs/01-PRD.md` line 22 | Not a defect. No action. Recorded so future ID audits do not flag it. |

**R-PREC-020** `Required` — Do not edit the files in `docs/01-PRD.md`, `docs/02-FLOWS.md` or `docs/03-TRD.md`. They are the delivered specifications and their integrity is verifiable. Corrections go in this register.

---

# 3. Architecture rules

## 3.1 The three-layer client split

`[TRD §2.2]` The single most common way this project's performance is destroyed is by putting canvas objects into React state.

**R-ARCH-001** `Blocking` — The client has exactly three layers with strict responsibilities.

| Layer | Technology | Owns | May re-render React? |
|---|---|---|---|
| **UI** | React components | Header, toolbar, panels, modals, toasts | Yes, on UI-relevant state only |
| **Render** | Plain TypeScript + `requestAnimationFrame` | Drawing pixels to the canvases | **Never** |
| **Sync** | Plain TypeScript classes | Socket, outbox, sequence numbers, reconnection | Only to update connection status |

**R-ARCH-002** `Blocking` — The renderer must not import React, must not be a React component, and must not be invoked from a React render pass. It reads the Zustand store directly via `store.subscribe()` outside React.

**R-ARCH-003** `Blocking` — Never subscribe a React component to the whole object map.

```ts
// GOOD — re-renders only when the tool changes
const tool = useBoardStore(s => s.activeTool)

// CATASTROPHIC — re-renders on every object mutation, 60 times a second
const objects = useBoardStore(s => s.objects)
```

**R-ARCH-004** `Required` — Where a React component needs object data (for example the properties panel), select **derived, minimal** data:

```ts
const fill = useBoardStore(s =>
  s.selection.length === 1 ? s.objects.get(s.selection[0])?.style.fill : undefined
)
```

## 3.2 Module boundaries

**R-ARCH-005** `Required` — The module tree in `[TRD §9.3]` is the agreed structure. Adding a top-level directory under `apps/web/src/features/` requires review.

**R-ARCH-006** `Required` — Module ownership is assigned to reduce merge conflicts `[PRD R-9]`. Editing a module you do not own requires a heads-up to the owner in the PR description.

| Module | Owner role |
|---|---|
| `features/canvas/renderer` | Renderer owner |
| `features/canvas/interaction` | Interaction owner |
| `features/sync` | Sync owner |
| `features/boards` + `features/auth` | Product owner |

**R-ARCH-007** `Blocking` — Shared types, Zod schemas, the socket contract and pure geometry helpers live in `packages/shared` and are imported by **both** client and server. Duplicating a type across the boundary is forbidden — that is how `strokeWidth` and `stroke_width` end up in the same system `[TRD §1.3]`.

**R-ARCH-008** `Required` — The server is the sole authority on ordering. Clients propose; the server decides `[TRD §0]`. Any question of "which change won" is answered by a server-assigned sequence number and by nothing else.

**R-ARCH-009** `Required` — Board state is a pure function of its op log `[TRD §0]`. If you cannot reconstruct the board by replaying its ops, you have introduced a bug.

---

# 4. Design-skill usage rules

## 4.1 General

**R-SKILL-001** `Blocking` — Skills are Tier 4 (§2.2). They inform craft; they never override a specification.

**R-SKILL-002** `Required` — Before invoking a skill, determine the **zone** of the surface you are building (§4.2). Invoking a skill outside its zone is a violation.

**R-SKILL-003** `Required` — Skill output is input to your judgement, not code to paste. Reconcile it against §2.3 before using it.

**R-SKILL-004** `Recommended` — Record which skills you invoked in the PR description. It makes design review faster.

## 4.2 The zoning map

**R-SKILL-010** `Blocking` — Each of the 22 screens belongs to exactly one zone. Only the skills listed for that zone may be applied.

| Zone | Screens | Skills that fire | Skills forbidden |
|---|---|---|---|
| **Marketing** | S-01 Landing | `gpt-taste`, `high-end-visual-design`, `design-taste-frontend`, `ui-ux-pro-max`, `framer-motion-animator` | — |
| **Auth** | S-02 Signup, S-03 Login, S-04 Forgot, S-05 Reset, S-06 OAuth callback | `ui-ux-pro-max`, `emil-design-eng`, `design-taste-frontend` (typography and colour guidance only) | `gpt-taste` — AIDA/hero grammar is wrong for a form |
| **Product chrome** | S-07 Dashboard, S-08 Trash, S-09 Template picker, S-16 Settings | `ui-ux-pro-max`, `emil-design-eng`, `framer-motion-animator` (lazy-loaded) | `gpt-taste`, `high-end-visual-design` |
| **Board chrome** | S-10 header/toolbar/panels/zoom, S-12 Share, S-13 Settings, S-14 Export, S-15 Shortcuts | `ui-ux-pro-max`, `emil-design-eng` | `gpt-taste`, `high-end-visual-design`, `framer-motion-animator` |
| **Canvas** | The four layers in FLOWS §14.3 | **None** | All six |
| **System states** | S-17 Access denied, S-18 Not found, S-19 Deleted, S-20 404, S-21 Error boundary | `ui-ux-pro-max`, `emil-design-eng` | `gpt-taste`, `high-end-visual-design` |
| **Guest** | S-11 Guest name entry, S-22 Onboarding tour | `ui-ux-pro-max`, `emil-design-eng`, `high-end-visual-design` (join card treatment only) | `gpt-taste` |

**R-SKILL-011** `Blocking` — **The canvas is a no-decoration zone.** No design skill applies to the four canvas layers. `[TRD §7]` is the only authority on what is drawn there and how. No entrance animation, no blur, no scroll effect, no shadow, no decorative gradient touches any canvas layer.

**R-SKILL-012** `Required` — Modals belong to the zone of the screen that opens them.

## 4.3 `ui-ux-pro-max`

**R-SKILL-020** `Required` — Its **colour and typography output is advisory only** and is superseded by `[PRD §15]` per `C-7`. Its UX guidelines, accessibility guidance, stack guidance and anti-pattern lists **are adopted**.

**R-SKILL-021** `Required` — Invoke with the absolute path. The skill's own documentation gives a relative `skills/…` path that does not resolve from the repository root:

```bash
python3 /root/.claude/skills/synced/ui-ux-pro-max/scripts/search.py "<query>" --domain ux -n 5
```

**R-SKILL-022** `Recommended` — Do not run `--design-system --persist`. It writes a `design-system/MASTER.md` whose palette and typography would contradict `[PRD §15]`, creating a second, wrong source of truth. The design-token contract in `CLAUDE.md` §7 is the master.

**R-SKILL-023** `Required` — Its pre-delivery checklist is adopted in full and is reproduced as `R-UI-040`.

## 4.4 `design-taste-frontend`

**R-SKILL-030** `Required` — The mandatory one-line **"Design Read"** must be stated before generating any marketing or auth surface.

**R-SKILL-031** `Required` — Dial values are **locked per zone**. Do not re-derive them per task.

| Zone | `DESIGN_VARIANCE` | `MOTION_INTENSITY` | `VISUAL_DENSITY` |
|---|---|---|---|
| Marketing (S-01) | 7 | 6 | 4 |
| Auth | 5 | 3 | 4 |
| Product chrome | 5 | 3 | 5 |
| Board chrome | 4 | 2 | 6 |
| System states | 4 | 2 | 3 |

Rationale: the skill's own inference table puts "minimalist / clean / Linear-style" at 5-6 / 3-4 / 2-3, and product UI at higher density. The board chrome sits lowest on motion because of `C-6`.

**R-SKILL-032** `Required` — **Adopted:** §3.C icons, §3.E layout mechanics, §4 bias corrections, §9 AI-tells, §14 pre-flight check. **Void here:** §3.A Tailwind v4 (`C-8`), its font guidance (`C-1`), and any application to board or canvas layout (`C-5`).

**R-SKILL-033** `Required` — Its §9.F "production-test tells" and §9.D "Jane Doe effect" apply to all seed and demo data. Use realistic board names and member names, not `Test Board 1` / `John Doe`.

## 4.5 `high-end-visual-design`

**R-SKILL-040** `Required` — Applies to the **Marketing zone and the S-11 guest join card only**.

**R-SKILL-041** `Required` — **Adopted:** the Variance Engine, Double-Bezel nested containers, button-in-button CTA architecture, macro-whitespace, custom cubic-béziers, and all of §6 Performance Guardrails. **Overridden:** its font ban (`C-1`) and icon ban (`C-2`).

**R-SKILL-042** `Blocking` — Its §6 guardrails are promoted to global rules because they agree with the PRD: animate only `transform` and `opacity`; apply `backdrop-blur` only to fixed or sticky elements, never to scrolling containers; attach grain overlays only to fixed `pointer-events-none` pseudo-elements; no arbitrary `z-index` values. See `R-MOTION-020`, `R-UI-030`.

## 4.6 `gpt-taste`

**R-SKILL-050** `Blocking` — Applies to **S-01 only**.

**R-SKILL-051** `Required` — Its mandatory `<design_plan>` pre-flight block must be produced before writing S-01 markup.

**R-SKILL-052** `Blocking` — **Its GSAP mandate is not adopted** (`C-3`). Reproduce its motion paradigms without GSAP:

| `gpt-taste` paradigm | CoBoard implementation |
|---|---|
| ScrollTrigger pinning | `position: sticky` + `IntersectionObserver` |
| Scrubbing text reveal | CSS scroll-driven animation (`animation-timeline: view()`) with an `IntersectionObserver` fallback |
| Image scale and fade on scroll | `IntersectionObserver` toggling a class; `transform`/`opacity` transition |
| Card stacking | `position: sticky` with incremental `top` offsets |

**R-SKILL-053** `Required` — **Adopted:** the AIDA structure, the 2-to-3-line H1 iron rule with wide containers, `grid-flow-dense` gapless bento, the meta-label ban ("SECTION 01", "QUESTION 05"), button-contrast verification, and the `overflow-x-hidden` page wrapper.

**R-SKILL-054** `Required` — Its `picsum.photos` guidance applies to S-01 placeholder imagery during development only. Production marketing imagery is a design deliverable, not a placeholder.

## 4.7 `framer-motion-animator`

**R-SKILL-060** `Blocking` — Framer Motion may be imported **only** from modules that land in the marketing or dashboard chunks. It is banned from the board route (`C-3`, `C-4`). Enforced by `R-PERF-021`.

**R-SKILL-061** `Required` — It must be lazy-loaded, never in the shared entry chunk.

**R-SKILL-062** `Required` — Use full `transform` strings rather than the `x`/`y` shorthand. Per `emil-design-eng`, the shorthand props are not hardware-accelerated and drop frames when the main thread is busy:

```tsx
<motion.div animate={{ x: 100 }} />                        // not hardware accelerated
<motion.div animate={{ transform: "translateX(100px)" }} /> // hardware accelerated
```

**R-SKILL-063** `Required` — `useReducedMotion` is mandatory in every animated component (`R-A11Y-010`).

**R-SKILL-064** `Required` — Never drive continuous pointer or scroll values through `useState`. Use `useMotionValue` / `useTransform` / `useScroll`.

## 4.8 `emil-design-eng`

**R-SKILL-070** `Required` — This is the **default motion authority for the whole application** (`C-6`), including zones where no other skill applies.

**R-SKILL-071** `Recommended` — Operational note: invoked with no specific question, this skill replies with a single fixed line and nothing else. Always invoke it with a concrete question, e.g. *"Review the toast enter/exit transitions in `Toast.tsx`."*

**R-SKILL-072** `Required` — Its review output format is mandatory when reviewing UI code: a single markdown table with `| Before | After | Why |` columns. Not a bulleted list.

**R-SKILL-073** `Required` — Its full rule set is adopted and reproduced as §13.

---

# 5. Canvas and rendering rules

`[TRD §7]`, `[FLOWS §14.3]`

## 5.1 The layer stack

**R-CANVAS-001** `Blocking` — Four stacked, absolutely positioned, identically sized elements. Contents and redraw triggers are fixed:

| Layer | Element | Contents | Redraws on |
|---|---|---|---|
| 0 | `<canvas id="grid">` `[P2]` | Dot grid | Viewport change only |
| 1 | `<canvas id="objects">` | All committed objects | Object create/update/delete, viewport change |
| 2 | `<canvas id="interaction">` | In-progress stroke, marquee, drag preview, alignment guides | Every `pointermove` during an interaction |
| 3 | `<canvas id="overlay">` | Selection boxes, handles, remote cursors, remote selections, remote in-progress strokes | Every frame while presence is active |
| 4 | `<div id="text-overlay">` | The DOM textarea for text editing | Only while editing text |

**R-CANVAS-002** `Blocking` — **A remote cursor moving must never cause layer 1 to redraw.** `[FLOWS §14.3]` If moving the mouse in one window drops the frame rate in another, the layering is wrong. This is the single most important performance rule in the project.

## 5.2 The render loop

**R-CANVAS-010** `Blocking` — Exactly **one** `requestAnimationFrame` loop exists in the entire application. Not one per layer, not one per component.

**R-CANVAS-011** `Blocking` — Never draw synchronously from an event handler. Event handlers mutate state and call `markDirty(layer)`. The loop draws.

**R-CANVAS-012** `Required` — The loop runs continuously and does nothing when no layer is dirty.

**R-CANVAS-013** `Required` — Stop the loop on `visibilitychange` → hidden; restart on visible.

**R-CANVAS-014** `Blocking` — `cancelAnimationFrame` on unmount. A leaked loop is a leaked CPU core.

## 5.3 Drawing

**R-CANVAS-020** `Required` — Cap device pixel ratio at 2. `Math.min(window.devicePixelRatio || 1, 2)`. 3× DPR quadruples fill cost for no visible gain and is ruinous on some phones.

**R-CANVAS-021** `Required` — Apply the viewport transform **once per frame**, not per object.

**R-CANVAS-022** `Required` — Batch by style. Sort visible objects by `strokeStyle` / `fillStyle` and set context properties only when they change. Context state changes are roughly 40% of frame cost at 5,000 objects `[TRD §12.1]`.

**R-CANVAS-023** `Blocking` — Never call `getImageData` in the render path. It forces a GPU→CPU sync and destroys the frame rate.

**R-CANVAS-024** `Blocking` — Never allocate objects inside the draw loop. GC pauses appear as dropped frames.

**R-CANVAS-025** `Required` — Cache images in a `Map<url, HTMLImageElement>` with LRU eviction at 100 entries. Never construct an `Image` in the draw loop.

**R-CANVAS-026** `Required` — Cull off-screen objects before drawing, with a `100 / zoom` padding margin so objects do not pop in.

**R-CANVAS-027** `Recommended` — Below 25% zoom, draw strokes as polylines with no curve interpolation. Curves are invisible at that scale.

**R-CANVAS-028** `Required` — Use integer coordinates for 1 px lines, or offset by 0.5, otherwise lines render blurry across two pixels.

**R-CANVAS-029** `Recommended` — Do not build a spatial index preemptively. A linear filter is fine to ~10,000 objects. Measure first `[TRD §7.4]`.

## 5.4 Strokes

**R-CANVAS-030** `Required` — Stroke points are a **flat `number[]` with stride 3** (`x, y, pressure`). Not `{x,y,p}[]` `[TRD D-9]`.

**R-CANVAS-031** `Required` — Render strokes with quadratic curves through midpoints, not straight segments `[TRD §7.5]`.

**R-CANVAS-032** `Blocking` — Run Ramer–Douglas–Peucker simplification (ε = 0.5 canvas units) **once, on `pointerup`**. Never during the stroke.

## 5.5 Hit testing

**R-CANVAS-040** `Required` — Two phases: cheap AABB rejection, then a precise per-type test. Iterate in reverse z-order so the topmost object wins.

**R-CANVAS-041** `Required` — Line, arrow and stroke hit tests include a `+ 4 / zoom` tolerance term so thin lines stay clickable at any zoom `[TRD §7.7]`.

**R-CANVAS-042** `Required` — For rotated objects, transform the test point into the object's local space, then test axis-aligned.

**R-CANVAS-043** `Required` — Handles have a minimum 8 px screen-space touch target regardless of zoom; 44 px on touch devices `[FLOWS E-11, §14.5]`.

## 5.6 The interaction state machine

**R-CANVAS-050** `Blocking` — Pointer handling is a state machine `[FLOWS §15.1]` with exactly one active state. Illegal transitions are bugs, not edge cases.

States: `IDLE`, `MARQUEEING`, `DRAGGING`, `RESIZING`/`ROTATING`, `DRAWING`, `PANNING`, `EDITING_TEXT`.

**R-CANVAS-051** `Blocking` — Entering `PANNING` from `DRAWING` is forbidden. Holding Space during a stroke does nothing.

**R-CANVAS-052** `Blocking` — `pointercancel` must be handled identically to a cancel. Ignoring it leaves the app stuck in `DRAGGING` forever.

**R-CANVAS-053** `Blocking` — Every state that captures the pointer releases it on exit, **including error paths**.

**R-CANVAS-054** `Required` — `setPointerCapture` on `pointerdown` for any drag or draw. Without it, dragging outside the window loses the interaction.

**R-CANVAS-055** `Required` — Tool changes during an interaction are queued and applied on return to `IDLE` `[FLOWS E-08]`.

**R-CANVAS-056** `Required` — `Escape` during a stroke cancels it entirely. Nothing is committed and nothing is broadcast `[FLOWS E-09]`.

---

# 6. Coordinate rules

`[PRD R-7]`, `[TRD §7.3]` — Coordinate-space confusion is rated "Very High" likelihood in the PRD risk register.

**R-COORD-001** `Blocking` — Two branded TypeScript types exist and are used:

```ts
type CanvasPoint = { x: number; y: number; __brand: 'canvas' }
type ScreenPoint = { x: number; y: number; __brand: 'screen' }
```

Passing one where the other is expected must be a compile error. This feels pedantic in week 1 and saves a full day in week 5.

**R-COORD-002** `Blocking` — **Never store screen coordinates.** Object positions are always canvas coordinates. If a stored coordinate changes when the user pans, that is a critical bug.

**R-COORD-003** `Blocking` — Clamp coordinates to ±1,000,000 on creation, client-side and server-side `[PRD FR-CANVAS-001, FLOWS E-04]`.

**R-COORD-004** `Required` — Conversion happens only through the two shared helpers in `packages/shared/src/geometry.ts`. Do not inline the arithmetic.

**R-COORD-005** `Blocking` — Zoom is anchored at the **pointer position**, never the viewport centre `[PRD FR-CANVAS-003]`. The formula is fixed:

```ts
const worldPos = screenToCanvas(pointerScreenPos, viewport)
const newZoom  = clamp(viewport.zoom * factor, 0.1, 5)
viewport.x = pointerScreenPos.x - worldPos.x * newZoom
viewport.y = pointerScreenPos.y - worldPos.y * newZoom
viewport.zoom = newZoom
```

**R-COORD-006** `Required` — Zoom is clamped hard to [0.1, 5] — 10% to 500%.

**R-COORD-007** `Required` — Panning mutates `viewport.x` / `viewport.y` only. It must not touch object data and must not re-run hit testing.

---

# 7. Sync and protocol rules

`[TRD §5]`, `[TRD §10]`

## 7.1 Ops versus presence

**R-SYNC-001** `Blocking` — Ops and presence are different categories and are never confused.

| | Ops | Presence |
|---|---|---|
| Examples | create / update / delete object | cursor, selection, in-progress stroke, drag preview |
| Persisted | **Yes** | **Never** |
| Sequence number | Yes | No |
| Acknowledged | Yes | No |
| Queued when offline | Yes | No — dropped |
| Lost message | Data loss, unacceptable | A cursor stutters, irrelevant |

**R-SYNC-002** `Blocking` — Never write a cursor position to the database.

**R-SYNC-003** `Blocking` — Never drop a create/update/delete op because a queue was full.

**R-SYNC-004** `Required` — Intermediate drag positions are presence, not ops `[PRD FR-CANVAS-011]`. Only the final position on release becomes an op.

**R-SYNC-005** `Required` — Partial stroke points are presence. Only the final committed stroke enters the op log `[PRD FR-RT-006]`.

## 7.2 Message handling

**R-SYNC-010** `Blocking` — Every inbound socket message is authorized, validated and rate-limited **before** it is applied. No exceptions, no fast paths `[TRD §5.4]`.

**R-SYNC-011** `Blocking` — A nacked op is **never retried**. A nack means the server made a decision; retrying produces the same decision. Retry loops on rejected ops are how you DDoS your own server `[TRD §10.1]`.

**R-SYNC-012** `Blocking` — Ops are persisted **before** the ack is sent. An acknowledged op must be durable or the zero-loss guarantee is a lie `[TRD D-14, PRD FR-RT-012]`.

**R-SYNC-013** `Blocking` — Sequence numbers are assigned by an `increment` inside a database transaction. **Never compute the next seq with `SELECT MAX(seq)` outside a transaction** — that is a race condition waiting to happen `[TRD §5.4]`.

**R-SYNC-014** `Required` — Op IDs are client-generated UUIDs and serve as the idempotency key. The server checks for an existing op with that ID and re-acks rather than duplicating.

**R-SYNC-015** `Required` — Ack the sender **first**, then broadcast to the room. The sender is waiting to clear its outbox.

**R-SYNC-016** `Required` — Never batch a `nack`. Errors go out immediately.

**R-SYNC-017** `Required` — The client batches ops emitted within one animation frame into a single `op_batch`. The server batches broadcasts on a 16 ms per-room timer.

## 7.3 Ordering and gaps

**R-SYNC-020** `Blocking` — Ops are applied in `seq` order. Never apply out of order `[TRD §6.3]`.

**R-SYNC-021** `Required` — An op with `seq <= lastAppliedSeq` is a duplicate. Ignore it `[FLOWS E-14]`.

**R-SYNC-022** `Required` — An op with `seq > lastAppliedSeq + 1` is a gap. Buffer it, drain contiguously, and schedule a debounced 500 ms gap-fill via `GET /operations?sinceSeq=` `[FLOWS E-15]`.

**R-SYNC-023** `Required` — An op for an unknown object id is logged and ignored. If it happens more than three times a minute, request a fresh snapshot — that indicates divergence `[FLOWS E-13]`.

## 7.4 Connection lifecycle

**R-SYNC-030** `Blocking` — Reconnection backoff uses **full jitter**: `random(0, min(1000 * 2^attempt, 30_000))`. Not `base ± jitter`. Unjittered backoff makes 50 clients retry in lockstep after a server restart `[TRD §10.2]`.

**R-SYNC-031** `Required` — These triggers bypass the backoff timer and retry immediately: the `online` event, `visibilitychange` → visible, and the user clicking "Retry now".

**R-SYNC-032** `Required` — The client sends `ping` every 25 s. If no `pong` arrives within 10 s, treat the connection as dead. Do not rely on the `close` event — a half-open TCP connection can hang for minutes `[TRD §5.1]`.

**R-SYNC-033** `Required` — The server terminates any socket silent for 60 s.

**R-SYNC-034** `Required` — Close-code reactions are fixed `[TRD §5.6]`: `1000`/`1001` no reconnect; `1006` reconnect with backoff; `4001` refresh token then reconnect **once**; `4003` do not reconnect, show S-17; `4004` do not reconnect, show S-18/S-19; `4029` reconnect after 30 s.

**R-SYNC-035** `Blocking` — On board load, the snapshot and the socket join run **in parallel**, and incoming ops are buffered until the snapshot resolves. Then apply the snapshot, replay buffered ops with `seq > snapshot.seq`, and drop those with `seq <= snapshot.seq`. This ordering is what prevents the "object flickers in then disappears" bug. Do not deviate `[FLOWS §2.3 step 5]`.

**R-SYNC-036** `Required` — On reconnect, in-flight ops were never acknowledged. Requeue them; server idempotency makes the duplicate send harmless.

**R-SYNC-037** `Required` — The outbox is persisted to `localStorage` so it survives an accidental refresh. Degrade silently if storage is unavailable `[FLOWS E-18]`.

**R-SYNC-038** `Required` — The toolbar **stays enabled** while reconnecting. The user keeps working; ops go to the outbox `[FLOWS §9.4]`.

## 7.5 Presence throttling

**R-SYNC-040** `Required` — Cursors send at 20 Hz maximum, and only when the position actually changed. Canvas coordinates, rounded to one decimal `[FLOWS §9.2]`.

**R-SYNC-041** `Required` — In-progress strokes send **deltas** since the last send, not the full point array. A 400-point stroke re-sent 20×/s is ~100 KB/s per user; deltas reduce that to hundreds of bytes `[TRD §10.3]`.

**R-SYNC-042** `Required` — Remote cursors are interpolated over 50 ms on receive. Raw jumps look broken.

**R-SYNC-043** `Required` — Never render your own remote cursor `[FLOWS §9.2]`.

**R-SYNC-044** `Required` — Above 100 selected objects, throttle presence transforms harder, to 10 Hz `[FLOWS E-07]`.

---

# 8. Conflict resolution and convergence rules

`[TRD §6]`, `[PRD FR-RT-007]`

**R-CONV-001** `Blocking` — The model is **server-ordered, last-writer-wins per field**. Not OT, not a CRDT `[TRD D-2]`.

**R-CONV-002** `Blocking` — `UPDATE` payloads are **partial**. Only the fields being changed are sent, and the merge replaces only those fields. Sending the full object on every update turns every concurrent edit into a lost update `[TRD §6.2]`.

**R-CONV-003** `Blocking` — Delete wins. A `CREATE` or `UPDATE` for a tombstoned object is a no-op. Never resurrect a deleted object.

**R-CONV-004** `Required` — Deleted objects retain an in-memory tombstone for the session so late-arriving updates are correctly ignored. Capped at 10,000 with FIFO eviction; cleared on board unload.

**R-CONV-005** `Required` — `CREATE` for an object that already exists is a no-op. Applying the same op twice must be safe.

**R-CONV-006** `Required` — The resolution algorithm must be commutative for disjoint objects, idempotent, and convergent. You should be able to explain all three properties in a code review.

**R-CONV-007** `Required` — Concurrent outcomes are fixed and are not errors:

| A does | B does | Result |
|---|---|---|
| Moves X | Moves Y | Both apply |
| Moves X | Recolours X | Both apply — different fields |
| Sets X fill red | Sets X fill blue | Later server seq wins; the loser sees the change. **No error shown** |
| Deletes X | Moves X | X stays deleted; the move is dropped silently |
| Deletes X | Deletes X | Idempotent no-op |
| Reorders z | Reorders z | Both valid — fractional indexing |

**R-CONV-008** `Required` — `zIndex` is a **fractional string key**, ordered lexicographically. Not an integer, not an array position `[TRD §6.4, D-8]`.

**R-CONV-009** `Required` — Cache the z-sorted array and invalidate on create/delete/z-change. Do not sort every frame.

**R-CONV-010** `Blocking` — Never trust client timestamps for ordering. Server sequence numbers are the only ordering authority `[FLOWS E-03]`.

**R-CONV-011** `Required` — The convergence debug panel (`?debug=1`) showing `lastAppliedSeq`, `objects.size` and a stable state hash must exist from **Phase 11**, not from the polish phase `[TRD §6.5]`. Two clients at the same `lastAppliedSeq` must show the same hash.

---

# 9. Undo and redo rules

`[TRD §8]`, `[PRD FR-CANVAS-018]` — Rated "High" likelihood, "High" impact in the risk register `[PRD R-3]`.

**R-UNDO-001** `Blocking` — **Only your own ops enter your history stack.** Remote ops applied via `receiveOps` must never call `history.push`. Enforce with distinct code paths: `applyRemoteOp` does not touch history; `applyAndEmit` does.

**R-UNDO-002** `Blocking` — Undo must never revert another user's work. This is the most commonly botched requirement in collaborative editors.

**R-UNDO-003** `Required` — An undo is emitted as a **normal op**. There is no special "undo" message type; remote clients see an ordinary change.

**R-UNDO-004** `Required` — A multi-object action is **one** history entry. Dragging 10 objects pushes one entry containing 10 forward and 10 inverse ops.

**R-UNDO-005** `Required` — A stale entry — one targeting an object that no longer exists — is **skipped silently**, and the next entry is tried. Maximum 10 skips per keypress to avoid a runaway loop. Never crash, never resurrect `[PRD AT-41]`.

**R-UNDO-006** `Required` — History does not survive a reload. It is deliberately not persisted.

**R-UNDO-007** `Blocking` — Capture previous values **before** applying an update, and capture **only the keys being changed**. Capturing the whole object makes undo clobber a teammate's concurrent edit to a different field `[TRD §8.2]`.

**R-UNDO-008** `Required` — Any new user action clears the redo stack. Always. No exceptions.

**R-UNDO-009** `Required` — History depth is capped at 100 entries.

**R-UNDO-010** `Required` — Grouping is fixed `[TRD §8.4]`: one stroke = 1 entry; drag of N objects = 1; delete of a multi-selection = 1; typing in a sticky = 1 per burst, coalescing updates within 1 s on the same object; resize = 1, pushed on `pointerup`; paste of N = 1.

---

# 10. Client state rules

`[TRD §9]`

**R-STATE-001** `Blocking` — Objects live in a `Map<ObjectId, BoardObject>`, not an array and not a plain object. O(n) lookups on 5,000 objects destroy the frame budget `[TRD §9.2]`.

**R-STATE-002** `Required` — Zustand compares by reference. Mutating a `Map` in place does not notify subscribers. Use a new `Map` for occasional writes; for the high-frequency drag path, mutate in place and bump an explicit `version` counter that the renderer watches.

**R-STATE-003** `Blocking` — These never enter React state: object geometry, cursor positions, in-progress stroke points, viewport during a pan or zoom gesture, drag offsets.

**R-STATE-004** `Required` — These may drive React re-renders: active tool, selection **count** and derived summary, connection status, presence **list**, board name, role, modal open state.

**R-STATE-005** `Required` — Tool choice persists to `localStorage` so it survives a refresh `[FLOWS §8.2.1]`.

**R-STATE-006** `Required` — Fall back to in-memory storage when `localStorage` is blocked (private mode). The app works; preferences simply do not persist. Show no error `[FLOWS E-18]`.

**R-STATE-007** `Required` — Every `useEffect` that adds a listener, timer, subscription or animation frame returns a cleanup `[PRD R-8]`.

---

# 11. Security rules

`[PRD §7.4]`, `[TRD §11]`

**R-SEC-001** `Blocking` — Authorization is enforced **server-side on every socket message and every HTTP request**. Client-side checks are UX only.

**R-SEC-002** `Blocking` — A viewer with the developer console open will try `socket.send({t:'op', …})`. The disabled toolbar is UX; the server check is security `[PRD AT-20]`.

**R-SEC-003** `Blocking` — Every inbound payload is validated against a Zod schema at the boundary. **Reject, do not coerce.**

**R-SEC-004** `Blocking` — Every numeric field has explicit finite bounds. `NaN` and `Infinity` are rejected by `.finite()`. An `Infinity` in a coordinate propagates through the renderer and blanks the canvas for every user in the room — a bug and a denial-of-service vector `[TRD §11.3]`.

**R-SEC-005** `Blocking` — Access tokens live **in memory only** — a module variable, never `localStorage`. Refresh tokens live in an `httpOnly`, `Secure`, `SameSite=Lax` cookie, rotated on every use `[TRD D-11]`.

**R-SEC-006** `Blocking` — Refresh token rotation includes reuse detection. Presenting a revoked token means theft: revoke the whole token family and force re-login.

**R-SEC-007** `Blocking` — Passwords are bcrypt, cost 12. Never logged, never returned by any endpoint.

**R-SEC-008** `Blocking` — Authentication errors are generic. Never reveal whether an email is registered `[PRD FR-AUTH-002]`.

**R-SEC-009** `Blocking` — Share tokens are ≥ 128 bits from a CSPRNG (32 bytes via `crypto.randomBytes`, base64url). Never sequential.

**R-SEC-010** `Blocking` — No `dangerouslySetInnerHTML` anywhere. Enforced by an ESLint rule.

**R-SEC-011** `Blocking` — SVG uploads are sanitized server-side with DOMPurify, or served from a separate origin.

**R-SEC-012** `Required` — Uploads are validated by **magic bytes**, not the client-supplied MIME type. Size is checked client-side first so a 50 MB file is rejected before upload `[FLOWS E-05]`.

**R-SEC-013** `Required` — Rate limits: login 5 per 15 min per email plus 20 per 15 min per IP; ops 100/s per socket; uploads 20/hour per user.

**R-SEC-014** `Required` — CORS uses an explicit origin allow-list. No wildcards.

**R-SEC-015** `Required` — The socket connection is authenticated during the handshake. An unauthenticated socket is closed, never left to linger.

**R-SEC-016** `Required` — Secrets come from environment variables. `.env` is git-ignored; `.env.example` is committed. **A secret in a commit means rotating the secret, not just reverting the commit.**

**R-SEC-017** `Required` — Never expose internal identifiers, stack traces or error codes to the user. Log them; show a friendly message with a short correlation ID `[PRD §8.1]`.

**R-SEC-018** `Required` — Never show the board name on the access-denied screen. Leaking the name of a board someone cannot access is an information leak `[FLOWS §12.1]`.

**R-SEC-019** `Required` — `npm audit` runs in CI and blocks on high or critical findings.

**R-SEC-020** `Required` — The permission check is cached in Redis for 60 s per `(boardId, identity)` and invalidated on any role change.

---

# 12. UI rules

## 12.1 Tokens

**R-UI-001** `Blocking` — `[PRD §15]` is the single source of truth for colour, radius, shadow, spacing, type and motion duration tokens. They are mapped through `tailwind.config.ts` → `theme.extend`.

**R-UI-002** `Blocking` — Never use an arbitrary colour value. If a colour is not in the token set, it does not go in the product.

**R-UI-003** `Required` — Spacing uses the 4 px base scale: 4, 8, 12, 16, 24, 32, 48. Never arbitrary spacing.

**R-UI-004** `Required` — Use theme colours directly (`bg-accent`), not `var()` wrappers.

**R-UI-010** `Blocking` — Typeface is Inter (`C-1`, `R-PREC-010`).

**R-UI-011** `Blocking` — Icons are Phosphor, one family, standardized weight (`C-2`, `R-PREC-011`). Never hand-roll SVG icon paths. Never mix icon families.

**R-UI-012** `Blocking` — **No emoji used as an icon**, anywhere.

**R-UI-013** `Blocking` — The **12-colour presence palette** is frozen exactly as specified in `[PRD §15]`. It is assigned round-robin per room and must render identically for every participant.

**R-UI-014** `Blocking` — The **8-colour sticky palette** is frozen exactly as specified. A sticky's colour is a persisted object property.

## 12.2 Interaction states

**R-UI-020** `Required` — Every clickable element has `cursor-pointer`.

**R-UI-021** `Required` — Every interactive element has a visible hover state that does **not** cause layout shift. Use colour, opacity, border or shadow — not scale transforms that reflow.

**R-UI-022** `Required` — Every interactive element has a visible focus ring.

**R-UI-023** `Required` — Pressable elements scale to `0.97` on `:active` (`R-MOTION-011`).

**R-UI-024** `Required` — Disabled states are visually distinct and are `aria-disabled` or genuinely disabled.

## 12.3 Contrast and modes

**R-UI-030** `Blocking` — `backdrop-blur` is applied only to fixed or sticky elements. Never to scrolling containers or large content areas — it causes continuous GPU repaints and severe mobile frame drops `[high-end-visual-design §6]`.

**R-UI-031** `Required` — Light-mode body text uses `--color-text-primary` (`#18181B`). Never a slate-400-class grey for body text.

**R-UI-032** `Required` — Muted text is no lighter than `--color-text-secondary` (`#71717A`).

**R-UI-033** `Required` — Borders must be visible in the mode they render in. `border-white/10` on a light background is invisible.

**R-UI-034** `Required` — Glass or translucent surfaces in light mode use `bg-white/80` or higher, not `bg-white/10`.

**R-UI-035** `Required` — Text contrast ≥ 4.5:1; UI boundary contrast ≥ 3:1.

## 12.4 Layout

**R-UI-040** `Required` — The `ui-ux-pro-max` pre-delivery checklist is adopted in full and must pass before any UI PR is opened:

- No emoji as icons
- All icons from one family
- Hover states cause no layout shift
- `cursor-pointer` on everything clickable
- Transitions 150–300 ms
- Focus states visible
- Light-mode contrast ≥ 4.5:1
- Borders visible in both modes
- Responsive at 375, 768, 1024 and 1440 px
- No horizontal scroll on mobile
- All images have alt text
- Form inputs have labels
- Colour is never the only indicator
- `prefers-reduced-motion` respected

**R-UI-041** `Required` — Never use `h-screen` for a full-height section. Use `min-h-[100dvh]` to avoid iOS Safari viewport jumping.

**R-UI-042** `Required` — Use CSS Grid over flexbox percentage arithmetic. `grid grid-cols-1 md:grid-cols-3 gap-6`, never `w-[calc(33%-1rem)]`.

**R-UI-043** `Required` — Breakpoints follow `[PRD §7.7]`: ≥1280 full layout; 1024–1279 properties panel becomes a popover; 768–1023 toolbar becomes a bottom bar, dashboard grid 2 columns; <768 mobile bottom toolbar with 5 core tools, no marquee select, single-column dashboard.

**R-UI-044** `Required` — Floating panels keep a 16 px margin from the viewport edge. Content must never hide behind fixed chrome.

**R-UI-045** `Required` — `z-index` values are systemic, from the fixed scale in `[FLOWS §14.2]`: canvas 0, toolbar/panels/zoom 20, guest bar 25, header 30, toasts 40, modal backdrop 45, modals 50, full-screen states 60. Never `z-[9999]`.

## 12.5 States and copy

**R-UI-050** `Blocking` — Every feature handles **loading, empty, error and offline** states. A feature without them is not done `[PRD §10.1]`.

**R-UI-051** `Required` — Lists load with **skeletons, not spinners**, sized to the real content so there is no layout shift `[FLOWS §6.3]`.

**R-UI-052** `Blocking` — All user-facing copy specified in `[PRD §8.2]` and `[PRD §8.3]` ships **verbatim** from a single `strings.ts` constant map. Copy must not be inlined at call sites, or it will drift.

**R-UI-053** `Required` — Tone rules `[PRD §8.1]`: second person, present tense; never blame the user; every error says what to do next; no exclamation marks except "Copied!" and celebratory empty states.

**R-UI-054** `Required` — Toasts never carry a decision. Anything requiring a choice is a modal `[FLOWS §13.1]`.

**R-UI-055** `Required` — Toast rules: bottom-left on the board, bottom-centre elsewhere; maximum 3 visible with older ones collapsing; info/success 3 s, error 6 s, error-with-action 8 s.

**R-UI-056** `Required` — Modal rules `[FLOWS §13.2]`: focus trap; initial focus on the first interactive element or the primary action; focus returns to the trigger on close; `Escape` closes unless a destructive action is in flight; backdrop click closes non-destructive modals only; body scroll locked; at most one modal at a time.

**R-UI-057** `Required` — Destructive confirmations state the object name and consequence, and permanent deletion requires typing the exact name.

**R-UI-058** `Required` — Never validate a form field before the user has left it once. Once a field has shown an error, re-validate on every keystroke so the error clears as soon as it is fixed `[FLOWS §3.2]`.

**R-UI-059** `Required` — Submit is never disabled for validation reasons — let the user click and show them what is wrong. It **is** disabled while a request is in flight.

**R-UI-060** `Required` — Seed and demo data uses realistic names. No `Test Board 1`, no `John Doe` `[design-taste-frontend §9.D]`.

---

# 13. Motion rules

Derived from `emil-design-eng`, which is the motion authority for this project (`C-6`, `R-SKILL-070`).

## 13.1 The frequency gate

**R-MOTION-001** `Blocking` — Before writing any animation, answer: **how often will the user see this?**

| Frequency | Decision |
|---|---|
| 100+ times/day — keyboard shortcuts, tool switching, selection, drawing | **No animation. Ever.** |
| Tens of times/day — hover effects, list navigation | Remove or drastically reduce |
| Occasional — modals, drawers, toasts | Standard animation |
| Rare / first-time — onboarding, celebrations | May add delight |

**R-MOTION-002** `Blocking` — **Never animate keyboard-initiated actions.** These are repeated hundreds of times daily; animation makes them feel slow and disconnected.

**R-MOTION-003** `Required` — Every animation must answer "why does this animate?" with one of: spatial consistency, state indication, explanation, feedback, or preventing a jarring change. "It looks cool" is not a purpose for anything the user sees often.

**R-MOTION-004** `Blocking` — **The canvas has no decorative motion** (`R-SKILL-011`). Objects do not fade in. Selections do not bounce. Tool switches do not transition. The only movement on the canvas is the movement the user is making.

## 13.2 Easing

**R-MOTION-010** `Blocking` — **Never use `ease-in` for UI.** It starts slow, delaying the exact moment the user is watching most closely, and feels sluggish at any duration.

**R-MOTION-011** `Required` — Easing selection is not a matter of taste:

| Situation | Easing |
|---|---|
| Entering or exiting | `ease-out` |
| Moving or morphing on screen | `ease-in-out` |
| Hover or colour change | `ease` |
| Constant motion (marquee, progress) | `linear` |
| Default | `ease-out` |

**R-MOTION-012** `Required` — Use custom curves. The built-in CSS easings are too weak. The project curves are:

```css
--ease-out:      cubic-bezier(0.23, 1, 0.32, 1);      /* UI interactions */
--ease-in-out:   cubic-bezier(0.77, 0, 0.175, 1);     /* on-screen movement */
--ease-drawer:   cubic-bezier(0.32, 0.72, 0, 1);      /* iOS-like drawer */
--easing-standard: cubic-bezier(0.2, 0, 0, 1);        /* PRD §15 default */
```

`--easing-standard` is the `[PRD §15]` token and is the default for token-driven transitions. The other three are additive and fill gaps the PRD does not specify.

## 13.3 Duration

**R-MOTION-020** `Required` — Durations are bounded:

| Element | Duration |
|---|---|
| Button press feedback | 100–160 ms |
| Tooltips, small popovers | 125–200 ms |
| Dropdowns, selects | 150–250 ms |
| Modals, drawers | 200–500 ms |
| Marketing / explanatory | May be longer |

**R-MOTION-021** `Required` — **UI animations stay under 300 ms.** A 180 ms dropdown feels more responsive than a 400 ms one.

**R-MOTION-022** `Required` — `[PRD §15]` duration tokens (`--duration-fast` 120 ms, `--duration-base` 200 ms, `--duration-slow` 320 ms) are the defaults for micro, standard and modal transitions respectively.

**R-MOTION-023** `Recommended` — Exit is faster than enter. Slow where the user is deciding, fast where the system is responding.

## 13.4 Technique

**R-MOTION-030** `Blocking` — **Animate only `transform` and `opacity`.** Never `top`, `left`, `width`, `height`, `margin` or `padding` — those trigger layout and paint.

**R-MOTION-031** `Required` — Never `transition: all`. Name the exact properties.

**R-MOTION-032** `Required` — **Never animate from `scale(0)`.** Nothing in the real world appears from nothing. Start from `scale(0.95)` with `opacity: 0`.

**R-MOTION-033** `Required` — Pressable elements: `transform: scale(0.97)` on `:active`, 160 ms `ease-out`.

**R-MOTION-034** `Required` — Popovers and tooltips are **origin-aware** — they scale from their trigger, not from centre. **Modals are exempt** and stay centred, because they are not anchored to a trigger.

**R-MOTION-035** `Required` — Use CSS **transitions**, not keyframes, for anything that can be triggered rapidly. Transitions retarget mid-flight; keyframes restart from zero.

**R-MOTION-036** `Recommended` — Use `@starting-style` for entry animations where browser support allows, falling back to the `data-mounted` pattern.

**R-MOTION-037** `Recommended` — Prefer percentage translations (`translateY(100%)`) over hardcoded pixels; they adapt to content.

**R-MOTION-038** `Recommended` — Use `filter: blur(2px)` to mask an imperfect crossfade. Keep blur under 20 px — heavy blur is expensive, especially in Safari.

**R-MOTION-039** `Required` — Stagger delays are 30–80 ms between items. Stagger is decorative and must never block interaction.

**R-MOTION-040** `Recommended` — Springs for drag momentum, interruptible gestures and decorative mouse-tracking. Keep bounce subtle (0.1–0.3), and avoid bounce in most product UI.

**R-MOTION-041** `Recommended` — Use WAAPI (`element.animate()`) when you need JavaScript control with CSS performance.

## 13.5 Library policy

**R-MOTION-050** `Blocking` — CSS is the default mechanism. Reach for a library only when CSS genuinely cannot express the interaction (`C-3`).

**R-MOTION-051** `Blocking` — **GSAP is not a dependency of this project.** Do not add it. Use the substitutions in `R-SKILL-052`.

**R-MOTION-052** `Blocking` — Framer Motion is permitted only in the marketing and dashboard chunks, lazy-loaded, and is **banned from the board route** (`R-SKILL-060`).

**R-MOTION-053** `Required` — CSS animations run off the main thread and stay smooth while the browser is busy; `requestAnimationFrame`-driven JS animation drops frames under load. Use CSS for predetermined animations and JS only for dynamic, interruptible ones.

## 13.6 Accessibility of motion

**R-MOTION-060** `Blocking` — Respect `prefers-reduced-motion`. Reduced motion means **fewer and gentler** animations, not zero: keep opacity and colour transitions that aid comprehension, remove movement and position animation.

**R-MOTION-061** `Required` — Gate hover animations behind `@media (hover: hover) and (pointer: fine)`. Touch devices fire hover on tap, causing false positives.

## 13.7 Review

**R-MOTION-070** `Required` — Motion review uses the `| Before | After | Why |` table format (`R-SKILL-072`).

**R-MOTION-071** `Recommended` — Review animations the next day, with fresh eyes, and in slow motion. Timing issues invisible at full speed are obvious at 5× duration.

---

# 14. Accessibility rules

`[PRD §7.5]` — The canvas itself cannot be made fully accessible with reasonable effort, and we accept that. **Everything around it must be.**

**R-A11Y-001** `Required` — All non-canvas UI is keyboard navigable with a visible focus ring.

**R-A11Y-002** `Required` — All controls have accessible names. Icon-only buttons require `aria-label`.

**R-A11Y-003** `Required` — Colour contrast ≥ 4.5:1 for text, ≥ 3:1 for UI boundaries.

**R-A11Y-004** `Required` — Modals trap focus, close on `Escape`, and restore focus to the trigger.

**R-A11Y-005** `Required` — Toasts announce via `aria-live="polite"`; errors use `"assertive"`.

**R-A11Y-006** `Required` — The canvas has a text alternative: `role="img"` with a summary such as "Whiteboard with 24 objects".

**R-A11Y-007** `Blocking` — Never convey information by colour alone. Presence colours are **always** paired with a name.

**R-A11Y-008** `Required` — The canvas is focusable (`tabIndex=0`) so keyboard shortcuts have a home. Tab order: header → toolbar → canvas → properties panel → zoom controls.

**R-A11Y-009** `Blocking` — Every keyboard shortcut is suppressed while a text input, the on-canvas text overlay, or a modal has focus — **except `Escape`** and `Cmd/Ctrl+Enter` `[PRD Appendix A]`.

**R-A11Y-010** `Blocking` — Respect `prefers-reduced-motion` (`R-MOTION-060`).

**R-A11Y-011** `Required` — Form inputs have associated labels. Errors are associated via `aria-describedby` and set `aria-invalid`.

---

# 15. Performance rules

`[PRD §7.1]` — These are budgets, not aspirations. A PR that regresses a budget does not merge.

**R-PERF-001** `Blocking` — The budgets:

| Metric | Budget |
|---|---|
| Landing page LCP | ≤ 1.5 s on 4G |
| Dashboard interactive | ≤ 2.0 s |
| Board first paint (500 objects) | ≤ 1.5 s |
| Board first paint (5,000 objects) | ≤ 3.0 s |
| Drawing frame rate | ≥ 55 fps with 5,000 objects |
| Pan/zoom frame rate | ≥ 55 fps |
| Input-to-local-pixel latency | ≤ 16 ms |
| Local-input-to-remote-render p95 | ≤ 250 ms |
| Initial JS bundle (gzipped) | ≤ 250 KB |
| Board route chunk (gzipped) | ≤ 200 KB |
| Memory with 5,000 objects | ≤ 300 MB heap |
| Typical WebSocket op | ≤ 2 KB |

**R-PERF-002** `Blocking` — p95 local-input-to-remote-render is 250 ms target, 500 ms hard ceiling `[PRD FR-RT-001]`.

**R-PERF-003** `Blocking` — The acting user's own changes render **immediately**, before server acknowledgement. Zero perceptible input lag on drawing `[PRD FR-RT-002]`.

**R-PERF-020** `Blocking` — Bundle size is a CI gate. A PR that pushes either bundle over budget fails the build.

**R-PERF-021** `Blocking` — An automated import check asserts the board route chunk contains no animation library (`C-3`, `C-4`).

**R-PERF-022** `Required` — Route-level code splitting: the landing and auth routes must not pull in the canvas engine.

**R-PERF-023** `Required` — Memory leak prevention is mandatory: cleanup on every listener, `cancelAnimationFrame` on unmount, LRU-capped image cache, presence entries deleted on leave and swept after 60 s idle, tombstones capped at 10,000, history capped at 100, canvas refs nulled on unmount.

**R-PERF-024** `Required` — Profile before optimizing. Typical cost distribution at 5,000 objects is context state changes ~40%, path construction ~25%, React re-renders ~20%, hit testing ~10%, serialization ~5% `[TRD §12.1]`.

**R-PERF-025** `Required` — A seeded 10,000-object stress board is committed to the repository and used for performance verification from Phase 1 `[PRD R-2]`.

---

# 16. Testing rules

`[TRD §13]`

**R-TEST-001** `Blocking` — Every feature ships with unit tests for its logic and at least one integration test each for the happy path and a failure path `[PRD §10.1]`.

**R-TEST-002** `Blocking` — These five tests exist and pass before v1 ships `[TRD §13.2]`:

1. Two clients converge after 200 random concurrent operations
2. Offline edits merge without loss
3. Undo does not revert another user's work
4. Delete wins over a concurrent move
5. A viewer cannot mutate the board with a forged socket message

**R-TEST-003** `Blocking` — The chaos scenarios `AT-30` to `AT-35` are ship-blocking `[PRD R-6]`.

**R-TEST-004** `Required` — Coverage target: 80% of `lib`, `geometry`, `history` and `sync`. These are pure functions and there is no excuse.

**R-TEST-005** `Required` — The convergence Playwright test drives two browser contexts through 200 random operations and asserts matching state hashes. This one test catches more real bugs than any other in the project.

**R-TEST-006** `Required` — Socket tests cover every message type: join, op, ack, nack, presence, reconnect.

**R-TEST-007** `Required` — Integration tests cover every REST endpoint including its authorization failures.

**R-TEST-008** `Required` — No new console errors or warnings.

---

# 17. Version control and review rules

`[TRD §14]`

**R-GIT-001** `Required` — Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`.

**R-GIT-002** `Required` — Conventional Commits: `feat(canvas): add rotation handle`.

**R-GIT-003** `Required` — Pull requests are capped at roughly **400 changed lines**. A 2,000-line PR will not be reviewed properly and everyone involved knows it.

**R-GIT-004** `Required` — Every PR description states the requirement IDs it implements, includes a screenshot or clip for UI work, gives test evidence, and notes any performance impact.

**R-GIT-005** `Required` — Bug reports cite the requirement ID they violate.

**R-GIT-006** `Blocking` — CI gates that block merge: `tsc --noEmit`, ESLint with zero warnings, unit and integration tests, bundle-size budget, `npm audit` high/critical, board-route import check. Playwright e2e blocks on `main` and is advisory on PRs. Lighthouse CI is advisory.

**R-GIT-007** `Required` — Every PR is reviewed and approved by one other person.

**R-GIT-008** `Blocking` — The Definition of Done `[PRD §10.1]` is a checklist, not a suggestion. All eleven items, not most:

1. Implements every acceptance criterion of its requirement ID
2. Handles loading, empty, error and offline states
3. Keyboard accessible with visible focus
4. Works at every breakpoint
5. Unit tests for logic; integration tests for happy path and one failure path
6. No new console errors or warnings
7. No TypeScript `any` without a comment explaining why
8. Meets the relevant performance budget
9. Copy matches PRD §8 exactly
10. Reviewed and approved by one other person
11. Server-side authorization enforced where applicable

---

# 18. Anti-pattern register

The consolidated "this has been tried and it breaks" list, drawn from all three specifications and all six skills. Each entry names the failure it causes.

## 18.1 Architecture and state

| # | Anti-pattern | What breaks |
|---|---|---|
| A-01 | Putting canvas objects in React state | 60 re-renders/second; frame rate collapses. The single most common way this project dies |
| A-02 | Subscribing a component to the whole object map | Same as A-01 |
| A-03 | Multiple `requestAnimationFrame` loops | Competing redraws, unpredictable frame budget |
| A-04 | Drawing synchronously from an event handler | Layout thrash, dropped frames, torn rendering |
| A-05 | Allocating inside the draw loop | GC pauses appear as dropped frames |
| A-06 | Duplicating a type across client and server | `strokeWidth` vs `stroke_width`; a day lost |
| A-07 | An objects table with `UPDATE`s instead of an op log | Reconnect gap-fill becomes impossible; no idempotent replay |

## 18.2 Coordinates and rendering

| # | Anti-pattern | What breaks |
|---|---|---|
| A-10 | Storing screen coordinates | Objects move when the user pans. Critical data corruption |
| A-11 | Centre-anchored zoom | Feels broken. Explicitly non-negotiable in the PRD |
| A-12 | Unbranded coordinate types | Screen/canvas mixups that compile fine and fail at runtime |
| A-13 | `getImageData` in the render path | GPU→CPU sync; frame rate destroyed |
| A-14 | DPR above 2 | Quadrupled fill cost for no visible gain |
| A-15 | Redrawing layer 1 on cursor movement | One user's mouse drops another user's frame rate |
| A-16 | Building a spatial index before measuring | Complexity with no demonstrated benefit |
| A-17 | Simplifying stroke points during the stroke | Wasted CPU on every `pointermove`; visible lag |

## 18.3 Interaction

| # | Anti-pattern | What breaks |
|---|---|---|
| A-20 | Ignoring `pointercancel` | App stuck in `DRAGGING` forever when the OS steals the pointer |
| A-21 | Omitting `setPointerCapture` | Dragging outside the window loses the stroke |
| A-22 | Allowing `DRAWING` → `PANNING` | Corrupted stroke state |
| A-23 | Implementing a text caret on canvas | Weeks of work, worse than a textarea, loses IME, spellcheck, mobile keyboards, a11y |
| A-24 | Persisting empty text objects | Invisible junk accumulates on the board |

## 18.4 Sync

| # | Anti-pattern | What breaks |
|---|---|---|
| A-30 | `SELECT MAX(seq)` outside a transaction | Two concurrent ops get the same sequence number. Divergence |
| A-31 | Retrying a nacked op | Retry loop; you DDoS your own server |
| A-32 | Acking before persisting | An acknowledged op can be lost. The zero-loss guarantee becomes a lie |
| A-33 | Sending the full object on update | Every concurrent edit becomes a lost update |
| A-34 | Applying ops out of sequence order | Divergence between clients |
| A-35 | Writing cursor positions to the database | Write amplification for data with no value |
| A-36 | Unjittered reconnection backoff | 50 clients retry in lockstep and hammer the server in waves |
| A-37 | Loading the snapshot and socket without the buffering rule | The classic "object flickers in then disappears" bug |
| A-38 | Trusting client timestamps for ordering | A user with a wrong clock corrupts ordering for everyone |
| A-39 | Resurrecting a tombstoned object | Zombie objects that cannot be deleted |

## 18.5 Undo

| # | Anti-pattern | What breaks |
|---|---|---|
| A-40 | Pushing remote ops onto the local undo stack | Undo reverts a teammate's work. Unacceptable |
| A-41 | Capturing the whole object for an inverse op | Undo clobbers a teammate's concurrent edit to a different field |
| A-42 | Pushing one entry per `pointermove` during a resize | 200 undo entries for one resize |
| A-43 | Crashing on a stale undo entry | Crash instead of a silent no-op |

## 18.6 Security

| # | Anti-pattern | What breaks |
|---|---|---|
| A-50 | Client-side-only permission checks | A viewer with the console open edits the board |
| A-51 | Access tokens in `localStorage` | Any XSS exfiltrates them |
| A-52 | Coercing invalid input instead of rejecting | `Infinity` in a coordinate blanks the canvas for the whole room |
| A-53 | Revealing whether an email is registered | Account enumeration |
| A-54 | Showing the board name on the 403 screen | Information leak |
| A-55 | Trusting the client-supplied MIME type | Malicious upload |
| A-56 | `dangerouslySetInnerHTML` | XSS |

## 18.7 Design and motion

| # | Anti-pattern | What breaks |
|---|---|---|
| A-60 | `ease-in` on UI | Feels sluggish at the exact moment the user is watching |
| A-61 | Animating from `scale(0)` | Elements appear from nothing; looks wrong |
| A-62 | `transition: all` | Animates properties you did not intend, including layout |
| A-63 | Animating `width`/`height`/`top`/`left` | Triggers layout and paint; drops frames |
| A-64 | Animating keyboard-initiated actions | Makes a 100×/day action feel slow forever |
| A-65 | `backdrop-blur` on a scrolling container | Continuous GPU repaints; severe mobile frame drops |
| A-66 | Keyframes on rapidly-triggered elements | Restart-from-zero jank instead of smooth retargeting |
| A-67 | Framer Motion `x`/`y` shorthand under load | Not hardware accelerated; drops frames |
| A-68 | Emoji as icons | Looks unprofessional; renders inconsistently across platforms |
| A-69 | Mixing icon families | Visually incoherent |
| A-70 | Hover scale transforms that shift layout | Content jumps under the cursor |
| A-71 | Spinners where skeletons belong | Layout shift on load |
| A-72 | Inlining copy at call sites | Copy drifts from the PRD |
| A-73 | Arbitrary `z-index` values like `z-[9999]` | Stacking wars |
| A-74 | Applying landing-page grammar to product UI | Violates the skills' own scope; produces a whiteboard that looks like a marketing site |
| A-75 | Placeholder names like "John Doe" in seed data | The "Jane Doe effect"; reads as unfinished |

## 18.8 Process

| # | Anti-pattern | What breaks |
|---|---|---|
| A-80 | Silently guessing at an ambiguous requirement | The single largest source of rework on projects like this |
| A-81 | Building the fun canvas parts and skipping error and empty states | Rated "Very High" likelihood in the risk register |
| A-82 | Scope creep — building comments, a font picker, grouping | PRD §2.2 is binding |
| A-83 | Starting the sync stage before the renderer is solid | You cannot tell which layer is lying to you; days lost |
| A-84 | A 2,000-line pull request | Will not be reviewed properly |
| A-85 | Deferring the convergence harness to the polish phase | The bug it catches will have compounded for four weeks |

---

# 19. Review checklists

Copy these into the PR description for the relevant zone.

## 19.1 Canvas or renderer PR

```
- [ ] No React import in renderer code                        R-ARCH-002
- [ ] Still exactly one rAF loop                              R-CANVAS-010
- [ ] Event handlers mark dirty; the loop draws               R-CANVAS-011
- [ ] No allocation inside the draw loop                      R-CANVAS-024
- [ ] Layer 1 does not redraw on cursor movement              R-CANVAS-002
- [ ] Branded coordinate types used throughout                R-COORD-001
- [ ] No screen coordinates stored                            R-COORD-002
- [ ] Pointer capture released on every exit path             R-CANVAS-053
- [ ] pointercancel handled                                   R-CANVAS-052
- [ ] Frame rate verified on the 10k stress board             R-PERF-025
- [ ] No decorative motion added to any canvas layer          R-MOTION-004
```

## 19.2 Sync or protocol PR

```
- [ ] Ops and presence not conflated                          R-SYNC-001
- [ ] Authorize, validate, rate-limit before applying         R-SYNC-010
- [ ] Persist before ack                                      R-SYNC-012
- [ ] seq assigned by transactional increment                 R-SYNC-013
- [ ] Nacks are not retried                                   R-SYNC-011
- [ ] Ops applied in seq order; gaps buffered                 R-SYNC-020
- [ ] Full jitter on backoff                                  R-SYNC-030
- [ ] Partial payloads on UPDATE                              R-CONV-002
- [ ] Tombstones respected; no resurrection                   R-CONV-003
- [ ] Convergence hash still matches across two clients       R-CONV-011
```

## 19.3 Auth or permissions PR

```
- [ ] Server-side authorization on every path                 R-SEC-001
- [ ] Zod validation at the boundary; reject, not coerce      R-SEC-003
- [ ] Access token in memory only                             R-SEC-005
- [ ] Refresh rotation with reuse detection                   R-SEC-006
- [ ] Generic auth errors                                     R-SEC-008
- [ ] Rate limits applied                                     R-SEC-013
- [ ] No board name leaked on 403                             R-SEC-018
- [ ] Forged-socket-message test added                        R-TEST-002
```

## 19.4 Product-chrome or board-chrome UI PR

```
- [ ] Zone identified; only permitted skills applied          R-SKILL-010
- [ ] PRD §15 tokens only; no arbitrary colours               R-UI-002
- [ ] Inter; Phosphor icons; no emoji as icons                R-UI-010/011/012
- [ ] Loading, empty, error and offline states present        R-UI-050
- [ ] Skeletons, not spinners                                 R-UI-051
- [ ] Copy pulled from strings.ts, matching PRD §8 verbatim   R-UI-052
- [ ] cursor-pointer, hover, focus, :active states            R-UI-020..023
- [ ] Frequency gate applied before animating anything        R-MOTION-001
- [ ] transform/opacity only; no ease-in; under 300ms         R-MOTION-030/010/021
- [ ] prefers-reduced-motion respected                        R-MOTION-060
- [ ] Focus trap and focus restore on modals                  R-UI-056
- [ ] Verified at 375 / 768 / 1024 / 1440 px                  R-UI-040
- [ ] No Framer Motion in the board chunk                     R-MOTION-052
```

## 19.5 Marketing (S-01) PR

```
- [ ] <design_plan> pre-flight produced                       R-SKILL-051
- [ ] One-line Design Read stated                             R-SKILL-030
- [ ] Dials at 7 / 6 / 4                                      R-SKILL-031
- [ ] AIDA structure present                                  R-SKILL-053
- [ ] H1 is 2-3 lines, wide container                         R-SKILL-053
- [ ] Bento grid uses grid-flow-dense; no empty cells         R-SKILL-053
- [ ] No meta-labels ("SECTION 01")                           R-SKILL-053
- [ ] No GSAP                                                 R-MOTION-051
- [ ] Scroll effects via IntersectionObserver / CSS           R-SKILL-052
- [ ] Inter, not a banned-list premium font                   R-PREC-010
- [ ] backdrop-blur only on fixed/sticky                      R-UI-030
- [ ] overflow-x-hidden wrapper; no horizontal scroll         R-SKILL-053
- [ ] LCP ≤ 1.5s on 4G                                        R-PERF-001
```

---

# 20. Exception process

**R-GIT-010** `Required` — To deviate from a `Blocking` or `Required` rule:

1. Open the PR with the deviation clearly marked in the description.
2. State the rule ID, what you are doing instead, and why the rule's underlying concern does not apply or is mitigated another way.
3. Get explicit written approval from the engineering lead in the PR thread. A review approval alone is not sufficient for a `Blocking` rule.
4. Add a code comment at the deviation site citing the rule ID and linking the PR.
5. If the exception is likely to recur, amend this document in the same PR rather than repeating the exception.

**R-GIT-011** `Recommended` — Exceptions are a signal. Three exceptions to the same rule means the rule is wrong. Fix the rule.

**R-GIT-012** `Required` — Rules are never deleted. A withdrawn rule keeps its ID, is marked `WITHDRAWN`, and records the date and reason.

---

# Appendix — rule index by ID

| Range | Domain | Section |
|---|---|---|
| `R-PREC-001` … `R-PREC-020` | Precedence, the eight conflicts, defect register | §2 |
| `R-ARCH-001` … `R-ARCH-009` | Architecture and module boundaries | §3 |
| `R-SKILL-001` … `R-SKILL-073` | Design-skill usage and zoning | §4 |
| `R-CANVAS-001` … `R-CANVAS-056` | Canvas rendering and interaction | §5 |
| `R-COORD-001` … `R-COORD-007` | Coordinate spaces | §6 |
| `R-SYNC-001` … `R-SYNC-044` | Sync engine and wire protocol | §7 |
| `R-CONV-001` … `R-CONV-011` | Conflict resolution and convergence | §8 |
| `R-UNDO-001` … `R-UNDO-010` | Undo and redo | §9 |
| `R-STATE-001` … `R-STATE-007` | Client state | §10 |
| `R-SEC-001` … `R-SEC-020` | Security | §11 |
| `R-UI-001` … `R-UI-060` | Visual and interaction design | §12 |
| `R-MOTION-001` … `R-MOTION-071` | Animation and motion | §13 |
| `R-A11Y-001` … `R-A11Y-011` | Accessibility | §14 |
| `R-PERF-001` … `R-PERF-025` | Performance | §15 |
| `R-TEST-001` … `R-TEST-008` | Testing | §16 |
| `R-GIT-001` … `R-GIT-012` | Version control, review, exceptions | §17, §20 |
