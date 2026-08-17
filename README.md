# CoBoard

**A real-time collaborative whiteboard.** Multiple people open the same board URL and simultaneously draw freehand strokes, place shapes, write text and drop sticky notes. Every action appears on every other screen within a few hundred milliseconds, with live labelled cursors.

> **Status: Phase 5 complete — milestone M1 all but done.** Monorepo, shared package, design tokens, CI gates, the canvas with pan and zoom, the pen, the full selection toolkit, and **every remaining object type** — rectangles, ellipses, lines, arrows, sticky notes and text, with a DOM text overlay, copy/paste, a context menu and alignment guides. Undo/redo is Phase 6. See [`docs/04-IMPLEMENTATION-PLAN.md`](./docs/04-IMPLEMENTATION-PLAN.md).
>
> Try it: `pnpm dev`, then `http://localhost:5173/?debug=1`. `V` select · `P` pen · `E` eraser · `R O L A` shapes · `N` sticky · `T` text. Add `&stress=1` for the 10,000-object stress board with the frame-timing overlay.

---

## Why this project exists

CoBoard demonstrates the two genuinely hard problems in modern frontend engineering:

1. **Real-time synchronization** — multiple writers mutating shared state concurrently over an unreliable network, with no ordering guarantees, where every client must converge on an identical final state.
2. **Complex, high-frequency UI state** — selection, tool, viewport, drag, undo and remote-user state all changing tens of times per second, at 60 fps.

---

## Documents

Read them in this order.

| Document                                                             | Answers                                                                                          | Size         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------ |
| [`CLAUDE.md`](./CLAUDE.md)                                           | **How to work in this repository** — architecture, commands, conventions, design-skill playbooks | ~800 lines   |
| [`RULES.md`](./RULES.md)                                             | **What is forbidden** — ~230 numbered, citable rules and the conflict-precedence ladder          | ~1,330 lines |
| [`docs/01-PRD.md`](./docs/01-PRD.md)                                 | **What** to build — 63 requirement IDs, personas, budgets, copy, acceptance tests                | 876 lines    |
| [`docs/02-FLOWS.md`](./docs/02-FLOWS.md)                             | **Where the user ends up** — 22 screens, routing guards, state machines, 22 edge cases           | 1,314 lines  |
| [`docs/03-TRD.md`](./docs/03-TRD.md)                                 | **How** to build it — stack, data model, WebSocket protocol, rendering engine                    | 1,607 lines  |
| [`docs/04-IMPLEMENTATION-PLAN.md`](./docs/04-IMPLEMENTATION-PLAN.md) | **In what order** — 15 phases, full traceability, 18 reference appendices                        | ~2,900 lines |

### Where to start

- **New to the project?** `docs/01-PRD.md` top to bottom, then `CLAUDE.md`, then `RULES.md` §2.
- **About to write code?** Find your phase in `docs/04-IMPLEMENTATION-PLAN.md` §7. It names the requirement IDs, flow sections, technical contracts, files and exit gate.
- **About to write UI?** `RULES.md` §2 and §4 first. Six design skills govern frontend work and they contradict each other in eight places — all eight are already resolved in writing.
- **Something is broken?** `CLAUDE.md` §15 is a symptom → document → section index.

---

## The build

45 working days across 15 phases, grouped into 5 milestones.

| Milestone              | Phases | Days  | Done when                                                                                    |
| ---------------------- | ------ | ----- | -------------------------------------------------------------------------------------------- |
| **M1 — It draws**      | 1–6    | 1–17  | Every tool works at 60 fps with 1,000 objects. Refreshing loses everything, and that is fine |
| **M2 — It persists**   | 7–8    | 18–23 | Sign up, create a board, draw, refresh, see your work                                        |
| **M3 — It syncs**      | 9–10   | 24–30 | Two windows show each other's strokes and cursors live and converge                          |
| **M4 — It survives**   | 11     | 31–33 | The network chaos tests pass                                                                 |
| **M5 — It's finished** | 12–15  | 34–45 | Every P0 and P1 requirement has a passing test and a reviewed PR                             |

**Scope:** 36 P0 + 19 P1 requirements are in the build. 8 P2 requirements and all stretch items are catalogued in Appendix N and are explicitly not built.

---

## Stack

React 18.3 · TypeScript 5.4 strict · Vite 6 (see **D-4**) · Zustand 4 · Canvas 2D · Tailwind 3.x · Phosphor icons · Node 20 · Express 4 · native `ws` · PostgreSQL 15 · Prisma 5 · Redis 7 · Vitest + Playwright

---

## Getting started

```bash
cp .env.example .env
docker compose up -d           # postgres + redis
pnpm install
pnpm db:migrate
pnpm dev                       # web :5173, server :3000
```

### If you have no Docker daemon

Some CI sandboxes and remote dev containers ship Postgres and Redis natively but
no Docker daemon. Use the fallback instead of `docker compose`:

```bash
bash scripts/dev-services.sh   # starts native postgres + redis
# ...
bash scripts/dev-services.sh --stop
```

Both paths produce the same `DATABASE_URL` and `REDIS_URL`, so `.env` is identical either way.

### Commands

| Command                  | What it does                                        |
| ------------------------ | --------------------------------------------------- |
| `pnpm dev`               | Both apps — web on :5173, server on :3000           |
| `pnpm typecheck`         | `tsc --build` across the workspace                  |
| `pnpm lint`              | ESLint, zero warnings tolerated                     |
| `pnpm test`              | Vitest unit and integration suite                   |
| `pnpm test:e2e`          | Playwright                                          |
| `pnpm build`             | Build all three packages                            |
| `pnpm analyze`           | Build, then enforce the PRD §7.1 bundle budgets     |
| `pnpm check:board-chunk` | Assert no animation library reaches the board chunk |
| `pnpm fixtures:generate` | Regenerate the 10,000-object stress board           |
| `pnpm db:migrate`        | Apply Prisma migrations                             |

Running Playwright against a preinstalled Chromium whose build number does not match
`@playwright/test`:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e
```

---

## A note on the specifications

The three documents in `docs/01`–`03` are preserved **exactly as delivered** and must not be edited. Their integrity is verifiable.

Six defects have been found in them so far. Rather than patching the sources, they are resolved in the defect register at [`RULES.md`](./RULES.md) §2.4:

| #       | Defect                                                                                                | Resolution                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-1** | `FR-BOARD-041` is referenced in the PRD but never defined — board requirements stop at `FR-BOARD-009` | The behaviour it points at (session expiry while a board is open) is fully specified as **`E-17`** in FLOWS §12.5. `E-17` is the binding requirement |
| **D-2** | `FR-CANVAS-017` is marked `[P1]` in its heading but `[P2]` / "Deferred. Do not build." in its body    | The body wins. Grouping is P2 and deferred                                                                                                           |
| **D-3** | `FR-BOARD-012` appears in PRD §0 as an illustrative example, not a requirement                        | Not a defect. Recorded so ID audits do not flag it                                                                                                   |
| **D-4** | TRD §1.1 pins Vite 5, but a high-severity advisory is patched only in ≥ 6.4.3                         | Upgraded to Vite 6.4.3. Security is Tier 1 and outranks the version pin                                                                              |
| **D-5** | TRD §7.6's "sort visible objects by style" reorders the draw sequence, breaking z-order               | Run-length style batching that preserves z-order. Same saving, no painter's-algorithm bug                                                            |

---

## Design governance

Six design and motion skills govern frontend work. They are **Tier 4** authority — they inform craft, they never override a specification.

They also contradict each other and the specs in eight concrete places. All eight are resolved in [`RULES.md`](./RULES.md) §2.3 with the losing side named, so they are not re-litigated in review:

| #   | Conflict          | Resolution                                                      |
| --- | ----------------- | --------------------------------------------------------------- |
| C-1 | Typeface          | **Inter** on all 22 screens                                     |
| C-2 | Icons             | **Phosphor**, one family                                        |
| C-3 | Animation library | **CSS-first**; Framer Motion non-canvas only; **no GSAP**       |
| C-4 | Bundle budget     | PRD §7.1 budgets are **blocking CI gates**                      |
| C-5 | Skill scope       | **Per-surface zoning map**                                      |
| C-6 | Motion vs 60 fps  | Frequency framework governs; **canvas is a no-decoration zone** |
| C-7 | Colour tokens     | **PRD §15 binding**; presence and sticky palettes frozen        |
| C-8 | Tailwind version  | **3.x**                                                         |
