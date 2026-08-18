# CoBoard — Implementation Plan

| Field               | Value                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| Document type       | Implementation Plan                                                                    |
| Version             | 1.0                                                                                    |
| Status              | Approved for build                                                                     |
| Audience            | Engineering team (frontend + backend), QA, design                                      |
| Source documents    | [`01-PRD.md`](./01-PRD.md), [`02-FLOWS.md`](./02-FLOWS.md), [`03-TRD.md`](./03-TRD.md) |
| Governing documents | [`../CLAUDE.md`](../CLAUDE.md), [`../RULES.md`](../RULES.md)                           |
| Duration            | 45 working days · 9 weeks                                                              |
| Structure           | 15 phases nested under 5 milestones                                                    |

---

# 0. How to use this plan

## 0.1 What this document is

The PRD says **what** to build. FLOWS says **where the user ends up**. The TRD says **how**. None of them says **in what order**, or tells you — for the task in front of you today — which requirement IDs it satisfies, which flow steps it implements, which technical contract to code against, and what "done" looks like.

This document does that. It is the fusion of all three, sequenced into 15 dependency-ordered phases.

## 0.2 The four-document relationship

```
  01-PRD.md         02-FLOWS.md          03-TRD.md
  (what + why)      (where + when)       (how)
       │                  │                   │
       └──────────────────┼───────────────────┘
                          ▼
              04-IMPLEMENTATION-PLAN.md
                   (in what order)
                          │
                          ▼
              CLAUDE.md  +  RULES.md
              (how to work) (what is forbidden)
```

## 0.3 Rules for using this plan

1. **Nothing here is optional unless marked `[P2]` or `[Stretch]`.**
2. **Phases are dependency-ordered.** Each depends only on what precedes it. Do not start a phase until the previous exit gate is genuinely met.
3. **Reference requirement IDs in every PR.** When you file a bug, reference the requirement ID it violates.
4. **If a requirement is ambiguous, it is ambiguous.** Do not guess. Ask. Ambiguity silently resolved by a guess is the single largest source of rework on projects like this (PRD §0, anti-pattern `A-80`).
5. **Read [`../RULES.md`](../RULES.md) §2 before your first UI task.** It resolves eight conflicts between the specifications and the six design skills. Re-litigating them in a PR thread wastes everyone's time.

## 0.4 Priority labels

| Label       | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `[P0]`      | Product does not function without this. Ship-blocking                      |
| `[P1]`      | Product functions but is embarrassing without this. Ship-blocking for v1.0 |
| `[P2]`      | Nice to have. Build only if P0 and P1 are complete and stable              |
| `[Stretch]` | Do not build. Listed so you know it was considered and deferred            |

The 15 phases cover **P0 and P1 only**. Everything deferred is catalogued in Appendix N.

## 0.5 The phase template

Each phase in §7 has eleven parts:

| Part | Contents                                                        |
| ---- | --------------------------------------------------------------- |
| 1    | **Header** — days, milestone, dependencies, owner module        |
| 2    | **Objective** — what is demoable at the end                     |
| 3    | **Requirements** — explicit `FR-*` IDs                          |
| 4    | **Flows** — FLOWS sections and step sequences                   |
| 5    | **Technical contract** — the TRD material, inlined              |
| 6    | **UI/UX workstream** — zone, skills that fire, commands, tokens |
| 7    | **Motion workstream** — what animates at all, curves, durations |
| 8    | **Tasks** — numbered, roughly a day each                        |
| 9    | **Files** — concrete paths                                      |
| 10   | **Tests** — including which `AT-*` become testable              |
| 11   | **Exit gate** — the binary condition to proceed                 |

---

# 1. Product summary

## 1.1 What CoBoard is

A browser-based real-time collaborative whiteboard. Multiple people open the same board URL and simultaneously draw freehand strokes, place shapes, write text, drop sticky notes and move things around. Every action any user takes appears on every other user's screen within a few hundred milliseconds. Users see each other's cursors move live, labelled with names.

## 1.2 Why it exists

To demonstrate the two genuinely hard problems in modern frontend engineering:

1. **Real-time synchronization** — multiple writers mutating shared state concurrently, over an unreliable network, with no guarantee of message ordering, where every client must converge on an identical final state.
2. **Complex, high-frequency UI state** — selection, tool, viewport, drag, undo and remote-user state all changing tens of times per second, at 60 fps.

## 1.3 The six success criteria

v1.0 succeeds when a person who has never seen the app can:

1. Open a link sent by a friend
2. Type a display name
3. Be drawing on a shared canvas within **10 seconds** of the click
4. See their friend's cursor and strokes appear live
5. Refresh the page and find everything exactly as they left it
6. Lose wifi for 20 seconds, get it back, and have their offline drawings merge without losing anything

If all six hold, we shipped.

---

# 2. Goals, non-goals, and the scope boundary

## 2.1 Product goals

| ID  | Goal                                             | Success measure                                                                        | Proven in    |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------ |
| G-1 | Real-time collaboration that feels instantaneous | p95 end-to-end latency under 250 ms                                                    | Phase 9      |
| G-2 | Zero data loss                                   | No committed operation is ever lost, across disconnects, refreshes and server restarts | Phase 11     |
| G-3 | Smooth drawing                                   | 60 fps local stroke rendering with 5,000 objects                                       | Phases 3, 15 |
| G-4 | Frictionless entry                               | A guest can join and draw without an account                                           | Phase 12     |
| G-5 | Convergence                                      | Any two clients with the same op set render identically                                | Phase 11     |
| G-6 | Graceful degradation                             | Usable offline, self-heals on reconnect                                                | Phase 11     |

## 2.2 Non-goals — binding

Do not build these. If you find yourself building one, stop.

| Non-goal                                      | Reason                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Video or voice chat                           | Enormous scope, adds nothing to the thesis                            |
| Mobile native apps                            | Web only. Responsive web is in scope; native is not                   |
| Offline-first PWA with full local persistence | We handle short disconnects, not multi-day offline work               |
| Rich document editing                         | Different problem domain                                              |
| Payments, billing, subscriptions              | No monetization in v1                                                 |
| Real-time collaborative code editing          | Different data model                                                  |
| SSO / SAML / enterprise identity              | Email + password + Google OAuth only                                  |
| AI features of any kind                       | Out of scope                                                          |
| Version history with time-travel scrubbing    | `[Stretch]` — the op log makes it possible later; do not build the UI |

## 2.3 The scope boundary

> **If a feature does not either (a) let a user put something on the canvas, (b) let a user see what someone else put on the canvas, or (c) let a user get to a canvas — it is out of scope for v1.**

PRD risk `R-5` rates scope creep "High" likelihood. §2.2 is binding. New scope goes to the backlog, not into the sprint.

---

# 3. Vocabulary

Everyone uses these words to mean exactly these things. Using them loosely causes bugs.

| Term                              | Definition                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Board**                         | A single infinite canvas with a unique ID and URL                                                                                     |
| **Object**                        | Anything on the board: stroke, rectangle, sticky note, text block, image. **We standardize on `object`** — not "shape", not "element" |
| **Operation (op)**                | An atomic, immutable change: create, update, delete. What travels over the wire and gets stored                                       |
| **Op log**                        | The append-only ordered list of every operation applied to a board. Board state is a pure function of it. **The source of truth**     |
| **Snapshot**                      | Materialized board state at a sequence number, so we don't replay 50,000 ops on load                                                  |
| **Session**                       | One user's active connection to one board                                                                                             |
| **Presence**                      | Ephemeral non-persisted data about a live session: cursor, selection, viewport, name, colour. **Never** written to the database       |
| **Viewport**                      | The visible rectangle: pan offset `(x, y)` and `zoom`                                                                                 |
| **Canvas coordinates**            | The board's own infinite space. Object positions are always stored in these                                                           |
| **Screen coordinates**            | Pixel positions in the browser window. **Never stored**                                                                               |
| **Local echo / optimistic apply** | Applying an op to your own screen before the server confirms                                                                          |
| **Convergence**                   | All clients end in the same state given the same ops, regardless of arrival order                                                     |
| **Room**                          | The server-side grouping of all sessions connected to one board                                                                       |

---

# 4. Architecture

## 4.1 System diagram

```
┌─────────────────────────────────────────────────────────────┐
│                       BROWSER (React)                       │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  UI Layer     │  │ Canvas       │  │  Sync Engine     │  │
│  │  (React)      │  │ Renderer     │  │  (plain TS)      │  │
│  │  header,      │  │ (imperative, │  │  socket client,  │  │
│  │  toolbar,     │  │  rAF loop,   │  │  outbox,         │  │
│  │  panels,      │  │  NOT React)  │  │  seq tracking,   │  │
│  │  modals       │  │              │  │  reconnection    │  │
│  └───────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│          └────────► ┌──────────────┐ ◄─────────┘            │
│                     │ Zustand      │                        │
│                     │ board store  │                        │
│                     └──────────────┘                        │
└──────────────┬──────────────────────────┬───────────────────┘
               │ HTTPS (REST)             │ WSS (ops + presence)
               ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│                     NODE.JS SERVER                           │
│  ┌────────────────┐            ┌──────────────────────────┐  │
│  │  REST API      │            │  WebSocket Gateway       │  │
│  │  auth, boards, │            │  handshake auth,         │  │
│  │  members,      │            │  room registry,          │  │
│  │  snapshots,    │            │  message router          │  │
│  │  uploads       │            │                          │  │
│  └───────┬────────┘            └────────────┬─────────────┘  │
│  ┌───────▼──────────────────────────────────▼─────────────┐  │
│  │  AuthService · BoardService · OpService ·               │  │
│  │  PresenceService · PermissionService · SnapshotService  │  │
│  └───────┬──────────────────────────────────┬─────────────┘  │
└──────────┼──────────────────────────────────┼───────────────┘
           ▼                                  ▼
   ┌───────────────┐                  ┌───────────────┐
   │  PostgreSQL   │                  │    Redis      │
   │  users boards │                  │  presence,    │
   │  members ops  │                  │  rate limits, │
   │  snapshots    │                  │  pub/sub      │
   └───────────────┘                  └───────────────┘
                    ┌───────────────┐
                    │  S3 storage   │  images, thumbnails
                    └───────────────┘
```

## 4.2 The three-layer client split

| Layer      | Technology                         | Owns                                           | Re-renders React?         |
| ---------- | ---------------------------------- | ---------------------------------------------- | ------------------------- |
| **UI**     | React components                   | Header, toolbar, panels, modals, toasts        | Only on UI-relevant state |
| **Render** | Plain TS + `requestAnimationFrame` | Drawing pixels                                 | **Never**                 |
| **Sync**   | Plain TS classes                   | Socket, outbox, sequence numbers, reconnection | Only connection status    |

```ts
// GOOD — re-renders only when the tool changes
const tool = useBoardStore(s => s.activeTool)

// CATASTROPHIC — re-renders on every object mutation, 60 times a second
const objects = useBoardStore(s => s.objects)
```

Rules `R-ARCH-001` … `R-ARCH-004`.

## 4.3 Three governing principles

1. **The server is the sole authority on ordering.** Clients propose; the server decides. Every ambiguity about "which change won" is answered by a server-assigned sequence number.
2. **The client is optimistic and never blocks on the network.** Drawing must feel instant even at 400 ms round-trip latency.
3. **State is derived, never guessed.** Board state is a pure function of its op log. If you cannot reconstruct the board from the log, you have a bug.

---

# 5. Repository layout and ownership

```
apps/web/src/
├── main.tsx   App.tsx
├── routes/          guards.tsx Landing Login Signup ForgotPassword
│                    ResetPassword OAuthCallback Dashboard Trash
│                    Settings GuestEntry Board
├── features/
│   ├── auth/        hooks, api, forms
│   ├── boards/      BoardCard BoardGrid useBoards api
│   ├── canvas/
│   │   ├── Canvas.tsx
│   │   ├── renderer/      Renderer.ts drawObjects drawInteraction
│   │   │                  drawOverlay shapes/
│   │   ├── interaction/   machine.ts usePointer useKeyboard useWheel
│   │   │                  handlers/
│   │   ├── geometry/      hitTest bounds transform simplify
│   │   └── history/       HistoryManager inverseOps
│   ├── sync/        SocketClient SyncEngine Outbox protocol
│   ├── presence/    usePresence CursorLayer AvatarStack
│   └── sharing/     ShareModal useMembers
├── components/ui/   Button Modal Toast Input Dropdown Tooltip
├── stores/          boardStore authStore uiStore
├── lib/             api cn throttle colours strings
└── types/           branded.ts

packages/shared/src/
├── schemas/         object op board auth      # Zod
├── protocol.ts                                # socket messages
├── geometry.ts                                # pure helpers
└── constants.ts                               # palettes, limits

apps/server/src/
├── index.ts
├── http/            app.ts routes/ middleware/
├── ws/              gateway RoomManager Session handlers/
├── services/        Auth Board Op Permission Snapshot Presence
├── db/              prisma client, migrations
└── lib/             redis s3 logger jwt
```

## 5.1 Module ownership

Four boundaries chosen so people rarely edit the same file — the practical answer to PRD risk `R-9`.

| Module                              | Owner             | Active in phases |
| ----------------------------------- | ----------------- | ---------------- |
| `features/canvas/renderer`          | Renderer owner    | 2, 3, 5, 10, 15  |
| `features/canvas/interaction`       | Interaction owner | 2, 4, 5, 6       |
| `features/sync`                     | Sync owner        | 9, 10, 11        |
| `features/boards` + `features/auth` | Product owner     | 7, 8, 12, 13, 14 |

---

# 6. Master phase table

| #   | Days  | Milestone | Title                                       | Deliverable                                      | Exit gate                                                |
| --- | ----- | --------- | ------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| 1   | 1–2   | M1        | Monorepo, shared package, Docker, CI        | Workspace runs, tokens wired, gates green        | `pnpm dev` runs both apps; CI passes on an empty PR      |
| 2   | 3–5   | M1        | Canvas layers, viewport, pan, zoom          | Four layers, one rAF loop, coordinate conversion | Pan and zoom at 60 fps on an empty board                 |
| 3   | 6–9   | M1        | Pen tool, stroke rendering, simplification  | Draw smooth strokes, local object store          | A 3-second scribble commits ~60 points, renders smoothly |
| 4   | 10–12 | M1        | Select, hit test, move, resize, marquee     | Full transform toolkit                           | All transforms work at every zoom level                  |
| 5   | 13–15 | M1        | Shapes, sticky notes, text overlay          | Every object type renders and edits              | All 7 non-image object types work                        |
| 6   | 16–17 | M1        | Local undo/redo                             | Inverse-op history                               | 100-step undo/redo works; `AT-42`–`AT-44` pass           |
| 7   | 18–20 | M2        | Auth REST, guards, token rotation           | Full auth flow                                   | Sign up, log in, refresh, deep-link preserved            |
| 8   | 21–23 | M2        | Boards CRUD, dashboard, op persistence      | Boards persist                                   | Draw, refresh, work is still there — `AT-10`             |
| 9   | 24–27 | M3        | WebSocket gateway, rooms, seq ordering      | Live sync                                        | Two windows sync live and converge — `AT-01`–`AT-05`     |
| 10  | 28–30 | M3        | Presence: cursors, avatars, live strokes    | Live collaboration feel                          | Cursors move smoothly; `AT-06`, `AT-07`                  |
| 11  | 31–33 | M4        | Reconnection, outbox, gap fill, conflicts   | Survives the network                             | Chaos tests `AT-30`–`AT-35` pass                         |
| 12  | 34–36 | M5        | Sharing, guest flow, permission enforcement | Guests can join and draw                         | Guest joins in under 10 s; `AT-20`–`AT-24`               |
| 13  | 37–38 | M5        | Export, thumbnails, trash, duplicate        | Feature complete                                 | Every P0/P1 feature exists                               |
| 14  | 39–42 | M5        | States, responsive, accessibility, polish   | Definition of Done met throughout                | Every state, breakpoint and a11y requirement passes      |
| 15  | 43–45 | M5        | Performance, e2e, deployment, monitoring    | Shipped                                          | All budgets met; deployed; monitoring live               |

## 6.1 Milestone mapping

| Milestone              | Phases | Days  | "Done when"                                                                                                |
| ---------------------- | ------ | ----- | ---------------------------------------------------------------------------------------------------------- |
| **M1 — It draws**      | 1–6    | 1–17  | Every tool works at 60 fps with 1,000 objects. Refreshing loses everything, and that is fine at this stage |
| **M2 — It persists**   | 7–8    | 18–23 | A user can sign up, create a board, draw, refresh, and see their work                                      |
| **M3 — It syncs**      | 9–10   | 24–30 | Two browser windows show each other's strokes and cursors live, and both converge to identical state       |
| **M4 — It survives**   | 11     | 31–33 | The chaos tests pass                                                                                       |
| **M5 — It's finished** | 12–15  | 34–45 | Every P0 and P1 requirement has a passing test and a reviewed PR                                           |

## 6.2 The warning about Phase 9

From TRD §16, and it is the most important scheduling note in the project:

> **This is where the project either succeeds or turns into a swamp.** Do not start it until stages 2–8 are genuinely solid. Debugging a sync bug on top of a shaky renderer means you cannot tell which layer is lying to you, and you will lose days to it.

---

# 7. The phases

---

## Phase 1 — Monorepo, shared package, Docker, CI

|                |                     |
| -------------- | ------------------- |
| **Days**       | 1–2                 |
| **Milestone**  | M1 — It draws       |
| **Depends on** | Nothing             |
| **Owner**      | Whole team, pairing |

### Objective

A pnpm workspace where `pnpm dev` starts both applications, Postgres and Redis run in Docker, the shared package is importable from both sides, PRD §15 design tokens are wired into Tailwind, and CI enforces every gate from day one — including the two new gates that protect the bundle budget.

Getting CI right on day one is what makes the budget rules in `RULES.md` §15 real rather than aspirational.

### Requirements

Infrastructure phase — no `FR-*` IDs. Establishes the foundation for all of them.

### Flows

None.

### Technical contract

**Stack** — TRD §1.1, §1.2. Versions are fixed:

| Concern         | Choice                                       | Version                               |
| --------------- | -------------------------------------------- | ------------------------------------- |
| Framework       | React                                        | 18.3                                  |
| Language        | TypeScript                                   | 5.4+, `strict: true`                  |
| Build           | Vite                                         | ~~5.x~~ **6.4.3+** — see defect `D-4` |
| Routing         | React Router                                 | 6.x                                   |
| Client state    | Zustand                                      | 4.x                                   |
| Server state    | TanStack Query                               | 5.x                                   |
| Styling         | **Tailwind CSS 3.x** — not v4 (`R-PREC-017`) | 3.x                                   |
| Sockets         | Native `WebSocket`                           | —                                     |
| Forms           | React Hook Form + Zod                        | latest                                |
| Testing         | Vitest, Testing Library, Playwright          | latest                                |
| Runtime         | Node.js                                      | 20 LTS                                |
| HTTP            | Express                                      | 4                                     |
| WebSocket       | `ws`                                         | —                                     |
| Database        | PostgreSQL                                   | 15                                    |
| ORM             | Prisma                                       | 5                                     |
| Cache / pub-sub | Redis                                        | 7                                     |
| Logging         | Pino                                         | —                                     |

**Why native WebSocket over Socket.IO** (TRD §1.4, D-1): Socket.IO is ~40 KB gzipped and provides reconnection and rooms — which is precisely the logic this project exists to demonstrate. Writing it ourselves is the point. Modern browser support for WebSocket is universal, so the long-polling fallback buys nothing.

**Branded coordinate types** — created now, in `packages/shared`, before any geometry exists (`R-COORD-001`, PRD risk `R-7`):

```ts
// packages/shared/src/types/branded.ts
export type CanvasPoint = { x: number; y: number; __brand: 'canvas' }
export type ScreenPoint = { x: number; y: number; __brand: 'screen' }

export const canvasPoint = (x: number, y: number): CanvasPoint =>
  ({ x, y }) as CanvasPoint
export const screenPoint = (x: number, y: number): ScreenPoint =>
  ({ x, y }) as ScreenPoint
```

**Environment variables** — TRD §15.3. `.env` is git-ignored; `.env.example` is committed (`R-SEC-016`):

```bash
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://…
REDIS_URL=redis://…
JWT_ACCESS_SECRET=            # 32+ random bytes
JWT_REFRESH_SECRET=           # different from the access secret
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
S3_ENDPOINT=  S3_BUCKET=  S3_ACCESS_KEY=  S3_SECRET_KEY=
SMTP_URL=
CLIENT_ORIGIN=https://coboard.app
MAX_UPLOAD_BYTES=10485760
MAX_OBJECTS_PER_BOARD=50000
SNAPSHOT_INTERVAL_OPS=500
```

**CI gates** — TRD §14.3 plus two additions from conflict `C-4`:

| Gate                                           | Blocking                       | Source             |
| ---------------------------------------------- | ------------------------------ | ------------------ |
| `tsc --noEmit`                                 | Yes                            | TRD §14.3          |
| ESLint, zero warnings                          | Yes                            | TRD §14.3          |
| Unit + integration tests                       | Yes                            | TRD §14.3          |
| **Bundle size budget**                         | Yes                            | `R-PERF-020`       |
| **Board-route animation-library import check** | Yes                            | `R-PERF-021` — new |
| `npm audit` high/critical                      | Yes                            | TRD §14.3          |
| Playwright e2e                                 | Yes on `main`, advisory on PRs | TRD §14.3          |
| Lighthouse CI                                  | Advisory                       | TRD §14.3          |

The ESLint config must include a `no-restricted-syntax` rule banning `dangerouslySetInnerHTML` (`R-SEC-010`).

### UI/UX workstream

**Zone:** none yet — this is infrastructure. **Skills:** none invoked.

The deliverable is the **token layer** that every later zone depends on. PRD §15 tokens go into `tailwind.config.ts` under `theme.extend` exactly as specified in `CLAUDE.md` §7.3. Both frozen palettes — 12 presence colours and 8 sticky colours — go into `packages/shared/src/constants.ts` because the server assigns presence colours and validates sticky colours (`R-UI-013`, `R-UI-014`).

Install `@phosphor-icons/react` now and add an ESLint rule banning other icon packages, so conflict `C-2` is enforced mechanically rather than by memory.

Create `apps/web/src/lib/strings.ts` as an empty typed constant map. Every user-facing string from PRD §8.2 and §8.3 lands here and nowhere else (`R-UI-052`).

### Motion workstream

Define the four curves and three durations as CSS custom properties and Tailwind theme entries. Nothing animates yet.

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
--easing-standard: cubic-bezier(0.2, 0, 0, 1); /* PRD §15 */
--duration-fast: 120ms;
--duration-base: 200ms;
--duration-slow: 320ms;
```

Add the global `prefers-reduced-motion` block now so no component has to remember it later (`R-MOTION-060`).

### Tasks

1. Initialize the pnpm workspace: `apps/web`, `apps/server`, `packages/shared`. Root `tsconfig` with project references and `strict: true`.
2. Vite + React + TypeScript in `apps/web`. Express + TypeScript in `apps/server`. Confirm both start.
3. `docker-compose.yml` with Postgres 15 and Redis 7, with named volumes and healthchecks.
4. Prisma initialized against the Docker Postgres. Empty initial migration to prove the connection.
5. Tailwind 3.x with the full PRD §15 token mapping. Both frozen palettes into `packages/shared/src/constants.ts`.
6. Branded coordinate types and the first Zod schemas in `packages/shared`. Import one from each side to prove the wiring.
7. ESLint + Prettier. Rules: no `dangerouslySetInnerHTML`, no icon package except Phosphor, no `framer-motion` import from board-route paths. _(Uses `eslint.config.js` flat config — ESLint 9's format — rather than the `.eslintrc.cjs` named above, which is the ESLint 8 format. Same rules.)_
8. Vitest configured for all three packages. Playwright configured with two browser contexts (needed from Phase 9).
9. CI pipeline with all eight gates. The bundle-size gate needs `rollup-plugin-visualizer` plus a size assertion.
10. `.env.example`, README bootstrap section, `pnpm db:seed` stub.
11. **Commit the 10,000-object stress board as a FIXTURE**, at `fixtures/stress-board.json`, with the deterministic generator that produced it (`scripts/generate-stress-board.ts`). Required from week 1 by PRD risk `R-2`; every later performance claim is measured against it (`R-PERF-025`).

    > **Correction to the original plan.** This task previously read "seed the 10,000-object stress board". It cannot be a _database_ seed at Phase 1 — the `Board` and `Operation` models do not exist until Phase 8. What PRD risk `R-2` actually requires is a stress board _"committed to the repo from week 1"_, which is a fixture. Phase 8 adds the DB seed that loads it.

### Files

```
package.json  pnpm-workspace.yaml  tsconfig.base.json  budgets.json
docker-compose.yml  .env.example  eslint.config.js  .prettierrc
scripts/dev-services.sh          # native postgres+redis fallback
fixtures/stress-board.json       # 10,000 objects, committed
.github/workflows/ci.yml
apps/web/{package.json,vite.config.ts,tailwind.config.ts,index.html}
apps/web/src/{main.tsx,App.tsx,index.css}
apps/web/src/lib/strings.ts
apps/server/{package.json,src/index.ts}
apps/server/prisma/schema.prisma
packages/shared/src/{index.ts,constants.ts,types/branded.ts,schemas/}
scripts/seed-stress-board.ts
scripts/check-board-chunk-imports.ts
```

### Tests

- Workspace resolution: a shared type imports cleanly from both apps.
- CI runs green on an empty PR.
- The bundle-size gate fails correctly when given a deliberately oversized fixture.
- The board-chunk import check fails correctly when given a fixture that imports `framer-motion`.

### Exit gate

`pnpm dev` starts both applications. `pnpm typecheck`, `pnpm lint`, `pnpm test` and the bundle gates all pass. `pnpm db:seed` produces the 10,000-object stress board. A deliberately wrong import fails CI.

---

## Phase 2 — Canvas layers, viewport, pan, zoom

|                |                                    |
| -------------- | ---------------------------------- |
| **Days**       | 3–5                                |
| **Milestone**  | M1                                 |
| **Depends on** | Phase 1                            |
| **Owner**      | Renderer owner + Interaction owner |

### Objective

Four stacked canvas layers, exactly one `requestAnimationFrame` loop, correct device-pixel-ratio handling, coordinate conversion in both directions, and every pan and zoom trigger working at 60 fps on an empty board.

This phase creates the foundation every visual feature sits on. Get the layering wrong here and Phase 10 becomes unfixable.

### Requirements

| ID              | Priority | Requirement                                                    |
| --------------- | -------- | -------------------------------------------------------------- |
| `FR-CANVAS-001` | P0       | Infinite canvas, coordinates clamped to ±1,000,000             |
| `FR-CANVAS-002` | P0       | Pan — space+drag, middle-mouse, two-finger trackpad, Hand tool |
| `FR-CANVAS-003` | P0       | Zoom — 10%–500%, pointer-anchored, with controls               |

### Flows

FLOWS §8.2.4 (pan and zoom), §14.3 (layer stack), §15.1 (the `PANNING` state).

### Technical contract

**The four layers** — FLOWS §14.3. Contents and redraw triggers are fixed (`R-CANVAS-001`):

| Layer | Element                     | Contents                                                | Redraws on                                |
| ----- | --------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| 0     | `<canvas id="grid">` `[P2]` | Dot grid                                                | Viewport change only                      |
| 1     | `<canvas id="objects">`     | All committed objects                                   | Object change, viewport change            |
| 2     | `<canvas id="interaction">` | In-progress stroke, marquee, drag preview, guides       | Every `pointermove` during an interaction |
| 3     | `<canvas id="overlay">`     | Selection boxes, handles, remote cursors and selections | Every frame while presence is active      |
| 4     | `<div id="text-overlay">`   | The DOM textarea for text editing                       | Only while editing                        |

> **The single most important performance rule in this project:** a remote cursor moving must never cause layer 1 to redraw. If moving a mouse in one window drops the frame rate in another, your layering is wrong. (`R-CANVAS-002`)

**DPR handling** — TRD §7.1. Cap at 2; 3× on some phones is ruinous:

```ts
function resizeCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(cssW * dpr)
  canvas.height = Math.floor(cssH * dpr)
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
  canvas.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0)
}
```

**The render loop** — TRD §7.2. Exactly one, for the whole application (`R-CANVAS-010`):

```ts
class Renderer {
  private dirty = { objects: true, interaction: true, overlay: true }
  private rafId = 0

  start() {
    this.rafId = requestAnimationFrame(this.tick)
  }
  stop() {
    cancelAnimationFrame(this.rafId)
  }

  markDirty(layer: keyof typeof this.dirty) {
    this.dirty[layer] = true
  }

  private tick = () => {
    if (this.dirty.objects) {
      this.drawObjects()
      this.dirty.objects = false
    }
    if (this.dirty.interaction) {
      this.drawInteraction()
      this.dirty.interaction = false
    }
    if (this.dirty.overlay) {
      this.drawOverlay()
      this.dirty.overlay = false
    }
    this.rafId = requestAnimationFrame(this.tick)
  }
}
```

Rules: never draw synchronously from an event handler — handlers mutate state and call `markDirty`, the loop draws (`R-CANVAS-011`). Stop on `visibilitychange` → hidden, restart on visible (`R-CANVAS-013`). `cancelAnimationFrame` on unmount (`R-CANVAS-014`).

**Coordinate conversion** — TRD §7.3:

```ts
interface Viewport {
  x: number
  y: number
  zoom: number
}

const canvasToScreen = (p: CanvasPoint, v: Viewport): ScreenPoint => ({
  x: p.x * v.zoom + v.x,
  y: p.y * v.zoom + v.y,
})

const screenToCanvas = (p: ScreenPoint, v: Viewport): CanvasPoint => ({
  x: (p.x - v.x) / v.zoom,
  y: (p.y - v.y) / v.zoom,
})
```

Apply the transform **once per frame**, not per object (`R-CANVAS-021`):

```ts
ctx.save()
ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
ctx.clearRect(0, 0, w, h)
ctx.translate(viewport.x, viewport.y)
ctx.scale(viewport.zoom, viewport.zoom)
// …draw every object in CANVAS coordinates…
ctx.restore()
```

**Pointer-anchored zoom** — FLOWS §8.2.4. Memorise this; you will write it three times. Centre-anchored zoom feels broken and is explicitly non-negotiable (`R-COORD-005`):

```ts
const worldPos = screenToCanvas(pointerScreenPos, viewport)
const newZoom = clamp(viewport.zoom * factor, 0.1, 5)
viewport.x = pointerScreenPos.x - worldPos.x * newZoom
viewport.y = pointerScreenPos.y - worldPos.y * newZoom
viewport.zoom = newZoom
```

**Pan triggers** — all must work: hold Space + drag (cursor → grabbing), middle-mouse drag, two-finger trackpad scroll (`wheel` with `ctrlKey === false`), Hand tool (`H`) + drag.

**Zoom triggers:** Cmd/Ctrl + wheel; pinch on trackpad (`wheel` with `ctrlKey === true` — this is how browsers report trackpad pinch; there is no "pinch" event); zoom buttons; `Cmd +`/`-`; `Cmd+0` → 100%; `Cmd+1` → zoom to fit.

**Zoom to fit:** bounding box of all objects, 10% padding, fit to the viewport rect, clamp to [0.1, 5]. With no objects, reset to `(0, 0, zoom 1)`.

**Viewport culling** — TRD §7.4, needed from the start so the stress board is usable:

```ts
function getVisibleObjects(objects: BoardObject[], v: Viewport, w: number, h: number) {
  const pad = 100 / v.zoom
  const view = {
    minX: -v.x / v.zoom - pad,
    minY: -v.y / v.zoom - pad,
    maxX: (w - v.x) / v.zoom + pad,
    maxY: (h - v.y) / v.zoom + pad,
  }
  return objects.filter(
    o =>
      o.x + o.width >= view.minX &&
      o.x <= view.maxX &&
      o.y + o.height >= view.minY &&
      o.y <= view.maxY,
  )
}
```

**Do not build a spatial index preemptively.** A linear filter is fine to ~10,000 objects. Measure first (`R-CANVAS-029`).

### UI/UX workstream

**Zone:** Board chrome (the zoom control) and Canvas (the layers themselves).

**Skills:** `ui-ux-pro-max` for the zoom control only. **No skill touches the canvas layers** (`R-SKILL-011`).

```bash
python3 /root/.claude/skills/synced/ui-ux-pro-max/scripts/search.py \
  "zoom control button group" --domain ux -n 5
```

Zoom controls sit bottom-right, 16 px margins, `z-index: 20`, ~180×40 px: `−`, percentage display (click resets to 100%), `+`, and zoom-to-fit. Tokens: `--color-bg-app`, `--color-border`, `--shadow-panel`, `--radius-md`.

**The canvas is declared a no-decoration zone from this phase forward** (`R-MOTION-004`, conflict `C-6`). No shadow, no gradient, no entrance animation on any layer, ever.

### Motion workstream

Apply the frequency gate (`R-MOTION-001`). Panning and zooming happen **hundreds of times per session** — top row of the table. **They do not animate.** The viewport follows the pointer exactly, with no easing, no smoothing and no inertia. Any interpolation here reads as lag, not polish.

The only motion in this phase is the zoom button `:active` press at `scale(0.97)`, 120 ms `--ease-out` (`R-MOTION-033`).

Cursor changes are instant: crosshair for draw tools, `grab`/`grabbing` for pan.

### Tasks

1. `Canvas.tsx` mounting four absolutely positioned layers plus the text overlay div, identically sized, correct z-order.
2. `resizeCanvas` with DPR capping. Handle window resize, preserving the viewport centre (`E-10`).
3. `Renderer` class with dirty flags and the single rAF loop. Visibility handling. Unmount cleanup.
4. ~~`screenToCanvas` / `canvasToScreen` in `packages/shared/src/geometry.ts`~~ — **already shipped in Phase 1.** Import from `@coboard/shared`; do **not** create `features/canvas/geometry/transform.ts`, which the file list below still names. A client-side copy would violate `R-ARCH-007` and `R-COORD-004`. Only genuinely client-only geometry (culling against a DOM-sized viewport) belongs under `features/canvas/geometry/`.
5. Viewport slice in the Zustand store. `clamp` helper. ±1,000,000 coordinate clamp.
6. `useWheel` — distinguish pan (`ctrlKey === false`) from zoom (`ctrlKey === true`).
7. Pointer-anchored zoom. Verify visually: the point under the cursor must not move.
8. All four pan triggers. `PANNING` state in the interaction machine, entered from `IDLE` only.
9. Zoom controls component and keyboard shortcuts (`Cmd+0`, `Cmd+1`, `Cmd +/-`).
10. Zoom to fit, including the empty-board case.
11. Viewport culling with the padding margin.
12. A debug overlay (`?debug=1`) showing viewport, zoom, visible-object count and live frame timing, plus a dev-only `?stress=1` loader for the fixture.

> **Corrections applied during implementation.**
>
> - **Geometry lives in `@coboard/shared`** (task 4 above). No `transform.ts` was created.
> - **A blockout object renderer is required here.** The exit gate measures fps against 10,000 objects, which needs _something_ drawn for them, but real stroke rendering is Phase 3 and shapes are Phase 5. Phase 2 draws each object as its tinted bounding box — enough to exercise culling, the once-per-frame transform and style batching honestly. Phase 3 replaces the stroke path.
> - **Layer 0 (grid) is `[P2]` and was not built.** Layers 1–3 plus the text-overlay div are mounted; the grid slot is reserved so z-order will not shift.
> - **No router yet.** `App.tsx` renders `<Canvas />` directly. React Router arrives in Phase 7 with the auth guards.

### Files

```
apps/web/src/features/canvas/Canvas.tsx
apps/web/src/features/canvas/renderer/{Renderer,drawObjects,drawInteraction,drawOverlay,resizeCanvas}.ts
apps/web/src/features/canvas/geometry/culling.ts        # client-only; transforms come from @coboard/shared
apps/web/src/features/canvas/interaction/{machine,usePointer,useWheel,useKeyboard}.ts
apps/web/src/features/canvas/interaction/handlers/pan.ts
apps/web/src/features/canvas/devFixture.ts
apps/web/src/components/board/ZoomControls.tsx
apps/web/src/components/dev/CanvasDebugOverlay.tsx
apps/web/src/stores/boardStore.ts
apps/web/vite.config.ts                                  # dev-only /fixtures middleware
tests/e2e/{canvas-viewport,canvas-performance}.spec.ts
```

### Tests

- Unit: `screenToCanvas(canvasToScreen(p)) === p` across a range of viewports.
- Unit: pointer-anchored zoom keeps the world point under the pointer fixed.
- Unit: zoom clamps hard at 0.1 and 5.
- Unit: culling includes objects partially on screen and excludes distant ones.
- Manual: pan and zoom the 10,000-object stress board, confirm ≥55 fps in the Chrome perf panel.

### Exit gate

Pan and zoom hold 60 fps on an empty board and ≥55 fps on the stress board. Pointer-anchored zoom is visually correct. Exactly one rAF loop exists in the application — verified by search. Layer 1 does not redraw on pan (verified by instrumenting the draw call).

---

## Phase 3 — Pen tool, stroke rendering, simplification, object store

|                |                |
| -------------- | -------------- |
| **Days**       | 6–9            |
| **Milestone**  | M1             |
| **Depends on** | Phase 2        |
| **Owner**      | Renderer owner |

### Objective

Draw a freehand stroke that feels instant, renders smoothly, simplifies on commit, and lands in a local object store. This is the first moment the product feels like a whiteboard.

### Requirements

| ID              | Priority | Requirement                                                                       |
| --------------- | -------- | --------------------------------------------------------------------------------- |
| `FR-CANVAS-005` | P0       | Pen / freehand tool (`P`), smoothing and simplification, colour/thickness/opacity |
| `FR-CANVAS-005` | P1       | Pressure sensitivity from `PointerEvent.pressure` where available                 |

### Flows

FLOWS §8.2.1 (draw a freehand stroke, all six steps), §14.4 (pen properties panel), §15.1 (the `DRAWING` state).

### Technical contract

**Stroke storage** — TRD §3.3, decision D-9. A flat `number[]` with stride 3, not `{x,y,p}[]`:

```ts
interface StrokeObject extends BaseObject {
  type: 'stroke'
  points: number[] // [x0,y0,p0, x1,y1,p1, …]
  color: string // #RRGGBB
  strokeWidth: number // 1–24
  simplified: boolean
}

for (let i = 0; i < points.length; i += 3) {
  const x = points[i],
    y = points[i + 1],
    pressure = points[i + 2]
}
```

`{x, y, pressure}[]` for a 200-point stroke allocates 200 objects and serializes to roughly 3× the bytes.

**The base object shape** — TRD §3.3, shared by every type:

```ts
interface BaseObject {
  id: ObjectId // uuid v4, generated client-side
  type: 'stroke' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'sticky' | 'text' | 'image'
  x: number // canvas coords, top-left of the bounding box
  y: number
  width: number
  height: number
  rotation: number // degrees, 0–359.99
  zIndex: string // FRACTIONAL index — a string, see Phase 9
  opacity: number // 0–1
  createdBy: string
  createdAt: number // client ms timestamp, DISPLAY ONLY, never for ordering
  updatedAt: number
}
```

**Stroke rendering** — TRD §7.5. Raw points produce visibly polygonal lines; render with quadratic curves through midpoints:

```ts
function drawStroke(ctx: CanvasRenderingContext2D, s: StrokeObject) {
  const p = s.points
  if (p.length < 6) return // fewer than 2 points

  ctx.beginPath()
  ctx.strokeStyle = s.color
  ctx.lineWidth = s.strokeWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.globalAlpha = s.opacity

  ctx.moveTo(p[0], p[1])
  for (let i = 3; i < p.length - 3; i += 3) {
    const midX = (p[i] + p[i + 3]) / 2
    const midY = (p[i + 1] + p[i + 4]) / 2
    ctx.quadraticCurveTo(p[i], p[i + 1], midX, midY)
  }
  ctx.lineTo(p[p.length - 3], p[p.length - 2])
  ctx.stroke()
  ctx.globalAlpha = 1
}
```

**Simplification** — Ramer–Douglas–Peucker, ε = 0.5 canvas units, run **once on `pointerup`, never during the stroke** (`R-CANVAS-032`). A 3-second scribble produces roughly 400 raw points and simplifies to around 60 with no visible difference — a 6× reduction in payload, storage and per-frame draw cost.

**The draw sequence** — FLOWS §8.2.1:

```
1. Press `P` or click the pen tool
   → tool button active; properties panel swaps to pen options
   → cursor → crosshair
   → persist the tool choice to localStorage                    [R-STATE-005]

2. pointerdown
   → setPointerCapture — without this, dragging outside the
     window loses the stroke                                    [R-CANVAS-054]
   → generate a client-side op id (uuid v4)
   → create a draft stroke with the first point
   → render on the INTERACTION layer, not the object layer

3. pointermove (up to 240 Hz on high-refresh devices)
   → append the point, converted screen → canvas
   → markDirty('interaction') only
   → (Phase 10 adds the throttled presence broadcast here)

4. pointerup / pointercancel
   → releasePointerCapture
   → simplify (RDP, ε = 0.5)
   → move from the interaction layer to the object layer
   → push an inverse op (delete) onto the undo stack   (Phase 6)
   → (Phase 9 adds the socket emit and outbox here)

   Escape at any point → discard entirely, broadcast nothing    [E-09]
```

**Store shape** — TRD §9.1, the parts that exist now:

```ts
interface BoardStore {
  objects: Map<ObjectId, BoardObject>
  tombstones: Set<ObjectId>
  sortedIds: ObjectId[] // cached z-order, invalidated on change
  viewport: Viewport
  activeTool: Tool
  toolSettings: Record<Tool, ToolSettings>
  selection: ObjectId[]
  interaction: InteractionState
  editingTextId: ObjectId | null
}
```

**The Zustand `Map` caveat** — TRD §9.2, and it bites everyone once. Zustand compares by reference, so mutating a `Map` in place does not trigger subscribers. Construct a new `Map` on write for occasional updates; for the high-frequency drag path, mutate in place and bump an explicit `version` counter the renderer watches (`R-STATE-002`).

**Performance rules that start applying now** — TRD §7.6: batch by style; never `getImageData` in the render path; never allocate inside the draw loop; below 25% zoom draw strokes as polylines with no curve interpolation.

### UI/UX workstream

**Zone:** Board chrome (toolbar, properties panel). The canvas stays skill-free.

**Skills:** `ui-ux-pro-max` and `emil-design-eng`. Dials 4/2/6.

```bash
S=/root/.claude/skills/synced/ui-ux-pro-max/scripts/search.py
python3 $S "toolbar tool selection active state" --domain ux -n 5
python3 $S "color swatch picker slider" --domain ux -n 5
```

**Left toolbar** — 56 px wide, vertically centred, floating with `--shadow-panel`, 16 px from the left edge, `z-index: 20`. Each button carries a tooltip with the tool name and its shortcut key. Active tool uses `--color-accent` background.

**Properties panel** — 240 px, floating right, 16 px from the edge, `z-index: 20`. Pen context shows colour swatches (10 + custom), thickness (5 presets + slider, 1–24 px), opacity slider (10–100%). Hidden entirely when the Select tool is active with an empty selection.

Icons are Phosphor, one weight (`R-UI-011`). Every button needs `aria-label` — they are icon-only (`R-A11Y-002`).

### Motion workstream

**Frequency gate:** tool switching happens dozens to hundreds of times per session. Top band. **Tool switching does not animate.** The active state changes instantly.

Permitted in this phase:

| Element               | Animation                                   | Duration | Curve        |
| --------------------- | ------------------------------------------- | -------- | ------------ |
| Tool button `:active` | `scale(0.97)`                               | 120 ms   | `--ease-out` |
| Tool button hover     | background colour                           | 120 ms   | `ease`       |
| Tooltip appear        | `opacity` + `scale(0.97)`→`1`, origin-aware | 125 ms   | `--ease-out` |
| Properties panel swap | `opacity` crossfade only, no slide          | 120 ms   | `--ease-out` |

Tooltips delay before the first appearance, then open instantly for adjacent triggers with no animation (§8.6 of `CLAUDE.md`). Hover animations gated behind `@media (hover: hover) and (pointer: fine)` (`R-MOTION-061`).

**Nothing on the canvas animates.** A committed stroke appears; it does not fade in.

### Tasks

1. Tool state in the store, `localStorage` persistence, keyboard shortcuts `V H P E R O L A N T`.
2. Left toolbar component with Phosphor icons, tooltips, active state, `aria-label`s.
3. Properties panel shell with the context-switching mechanism; pen context implemented.
4. `DRAWING` state in the interaction machine. `IDLE` → `DRAWING` on pointerdown with a draw tool.
5. Pointer capture, draft stroke creation, point appending with screen→canvas conversion.
6. `drawStroke` with quadratic midpoint interpolation on the interaction layer.
7. RDP simplification in `geometry/simplify.ts`. Unit tests against known point sets.
8. Commit on pointerup: simplify, move to the object layer, insert into the `Map`, invalidate `sortedIds`.
9. `Escape` and `pointercancel` handling — discard cleanly, release capture (`R-CANVAS-052`).
10. Pressure sensitivity from `PointerEvent.pressure` where available, defaulting to 0.5 (`[P1]`).
11. Below-25%-zoom polyline fallback.
12. Object-layer drawing with style batching and culling.

> **Corrections applied during implementation.**
>
> - **RDP lives in `@coboard/shared`, not `features/canvas/geometry/simplify.ts`.** It is pure geometry over a stride-3 array with no DOM dependency, §5 puts pure geometry helpers in the shared package, and the server needs the same function in Phase 9 to bound op payloads. A client-side copy would breach `R-ARCH-007`. `simplifyStroke` and `strokeBounds` were added to `packages/shared/src/geometry.ts`. Same correction shape as Phase 2's `transform.ts`.
> - **`packages/shared/src/schemas/object.ts` already existed.** Phase 1 shipped `StrokeObjectSchema` with the stride-3 `points` array and finite bounds on every field. Phase 3 consumes it unchanged; the file list above was stale.
> - **Style batching preserves z-order — defect `D-5`.** TRD §7.6's "sort visible objects by `strokeStyle`/`fillStyle`" breaks the painter's algorithm and contradicts `R-CONV-009`: two overlapping opaque strokes would resolve differently from the data. Implemented as **run-length batching in z-order** — context state is written only when the style key differs from the previous object, and nothing is reordered. Recorded in `RULES.md` §2.4.
> - **Layer 1 now iterates `sortedIds`.** Phase 2's renderer read `objects.values()`, i.e. insertion order. Invisible while every object was a blockout tint; a visible z-order bug the moment real overlapping strokes exist.
> - **Only implemented tools get keyboard shortcuts.** All eleven tools render (FLOWS §14.2), but the eight without an implementation are **disabled** and unbound. A shortcut that selects a tool which then draws nothing is worse than no shortcut. `ACTIVE_TOOLS` is now `['select', 'hand', 'pen']`.
> - **Component tests run on `happy-dom`, not `jsdom`.** jsdom 30 declares `engines: ^22.22.2 || ^24.15.0 || >=26`, excluding the Node 20 LTS that TRD §1.1 pins. It installs silently, passes on a Node 22 dev machine, then fails in CI inside `undici` with `webidl.util.markAsUncloneable is not a function`. happy-dom declares `>=20` and has no undici dependency. `engine-strict=true` was added to `.npmrc` so the next such mismatch fails at install with a package name rather than at runtime with a stack trace.
> - **Pressure is captured, not rendered as variable width** — agreed scope decision on the `[P1]` sub-item. `PointerEvent.pressure` is normalised, stored in the stride-3 array, carried through simplification and persisted. It is not drawn as taper: TRD §7.5 sets one `lineWidth` for the whole path, and visible taper needs either a filled outline polygon or one `stroke()` per segment — the second is `R-CANVAS-022`'s failure mode multiplied by every point in every object, and both contradict explicit Tier 2 spec code. The data is stored, so a later phase can render it without a migration.

### Files

```
packages/shared/src/geometry.ts                          # simplifyStroke + strokeBounds (NOT a client copy)
apps/web/src/features/canvas/renderer/shapes/stroke.ts
apps/web/src/features/canvas/renderer/{drawObjects,drawInteraction,Renderer}.ts
apps/web/src/features/canvas/interaction/handlers/draw.ts
apps/web/src/features/canvas/interaction/{usePointer,useKeyboard}.ts
apps/web/src/components/board/{Toolbar.tsx,PropertiesPanel.tsx}
apps/web/src/components/board/properties/PenProperties.tsx
apps/web/src/components/ui/{Tooltip.tsx,ColorSwatch.tsx,Slider.tsx}
apps/web/src/lib/persist.ts                              # validated localStorage
apps/web/src/stores/boardStore.ts
tests/e2e/canvas-draw.spec.ts
```

### Tests

- Unit: RDP reduces ~400 points to ~60 at ε = 0.5, and preserves endpoints exactly.
- Unit: RDP on a straight line reduces to two points.
- Unit: RDP is iterative — `STROKE_POINTS_MAX` input must not overflow the stack. A crash in the shared package takes the _server_ down in Phase 9, not just a tab.
- Unit: stroke bounding box accounts for `strokeWidth`.
- Unit: run-length batching writes `strokeStyle` once per run **and never reorders** (the `D-5` regression test).
- Unit: `localStorage` reads are validated — a hostile or stale value falls back to defaults.
- Component: selecting the pen tool swaps the properties panel and persists to `localStorage`.
- E2E: drawing does not repaint layer 1 (`R-CANVAS-002`), asserted from the renderer's own paint counters.
- E2E perf: a scripted drag on the stress board, reporting frame p50/p95 **and input-to-pixel p50/p95** from the renderer's instrumentation. Loose CI floors; the real figures are printed to the log and recorded in the PR.

### Exit gate

A 3-second scribble renders smoothly with no visible polygonal segments, commits to roughly 60 points, and appears on the object layer. Drawing on the 10,000-object stress board holds ≥55 fps. `Escape` mid-stroke leaves no trace.

---

## Phase 4 — Select, hit test, move, resize, delete, marquee

|                |                   |
| -------------- | ----------------- |
| **Days**       | 10–12             |
| **Milestone**  | M1                |
| **Depends on** | Phase 3           |
| **Owner**      | Interaction owner |

### Objective

The complete selection and transformation toolkit, driven by a rigorous state machine. This phase is where the interaction machine from FLOWS §15.1 becomes real, and where most "stuck in a weird state" bugs are prevented or created.

### Requirements

| ID              | Priority | Requirement                                                                                   |
| --------------- | -------- | --------------------------------------------------------------------------------------------- |
| `FR-CANVAS-004` | P0       | Select tool (`V`) — click, shift+click, marquee, bounding box with 8 resize + 1 rotate handle |
| `FR-CANVAS-011` | P0       | Move objects — drag, arrow-key nudge 1 px, shift+arrow 10 px                                  |
| `FR-CANVAS-012` | P0       | Resize — corner and edge handles, Shift aspect, Alt from centre, min 8×8                      |
| `FR-CANVAS-014` | P0       | Delete — `Delete`/`Backspace`, undoable                                                       |
| `FR-CANVAS-022` | P0       | Select all (`Cmd+A`) / deselect (`Escape`)                                                    |
| `FR-CANVAS-006` | P0       | Eraser tool (`E`) — object eraser, red highlight on hover, delete on drag                     |
| `FR-CANVAS-013` | P1       | Rotate — handle above the box, Shift snaps to 15°                                             |

### Flows

FLOWS §8.2.3 (select and transform, all four sub-modes), §15.1 (the full machine), §12.5 edge cases `E-07`, `E-08`, `E-11`.

### Technical contract

**The interaction state machine** — FLOWS §15.1. Only one state is active at a time; illegal transitions are bugs (`R-CANVAS-050`):

```
                            ┌──────┐
              ┌────────────►│ IDLE │◄───────────────┐
              │             └──────┘                │
              │        pointerdown │                │
              │      ┌─────────────┼──────────┐     │
       on empty+     │      on object    on handle  │
       select tool   │      +select tool      │     │
              ▼      │             ▼          ▼     │
        ┌──────────┐ │      ┌───────────┐ ┌────────────┐
        │MARQUEEING│ │      │ DRAGGING  │ │ RESIZING/  │
        └──────────┘ │      └───────────┘ │ ROTATING   │
              │      │             │      └────────────┘
      pointerup      │       pointerup          │ pointerup
              └──────┼─────────────┴────────────┘
                     │
        with a draw tool active
                     ▼
              ┌────────────┐
              │  DRAWING   │──pointerup──► commit ──► IDLE
              └────────────┘
                     │ Escape / pointercancel
                     └──► discard ──► IDLE

        Space held (any state except DRAWING / text edit)
                     ▼
              ┌──────────┐
              │ PANNING  │──released──► previous state
              └──────────┘
```

Four rules, all `Blocking`:

- Entering `PANNING` from `DRAWING` is **forbidden**. Space during a stroke does nothing (`R-CANVAS-051`).
- `pointercancel` — fired when the OS steals the pointer, e.g. a system gesture — must be handled **identically to a cancel**, never ignored. Forgetting this leaves the app stuck in `DRAGGING` forever (`R-CANVAS-052`).
- Every state that captures the pointer must release it on exit, **including error paths** (`R-CANVAS-053`).
- Tool changes are queued and applied on return to `IDLE` (`R-CANVAS-055`, `E-08`).

**Hit testing** — TRD §7.7. Two phases, reverse z-order so the topmost wins:

```ts
function hitTest(point: CanvasPoint, objects: BoardObject[]): BoardObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i]
    if (!pointInBounds(point, o)) continue // cheap AABB rejection
    if (preciseHitTest(point, o)) return o // precise per-type test
  }
  return null
}
```

| Type                | Precise test                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| rect, sticky, image | Bounding box, with a corner-radius check when the radius is large           |
| ellipse             | `((dx/rx)² + (dy/ry)²) ≤ 1`                                                 |
| line, arrow         | Distance to the segment ≤ `strokeWidth/2 + 4/zoom`                          |
| stroke              | Distance to any segment ≤ `strokeWidth/2 + 4/zoom`, early-exit on first hit |
| text                | Bounding box                                                                |

The `+ 4/zoom` term is a constant 4-pixel screen-space tolerance so thin lines stay clickable at any zoom. Without it, a 1 px line at 10% zoom is impossible to select (`R-CANVAS-041`).

For rotated objects, transform the test point into the object's local space — translate to centre, rotate by `−rotation`, translate back — then test axis-aligned (`R-CANVAS-042`).

**Transform behaviours** — FLOWS §8.2.3:

```
MOVE
  pointerdown inside the bounding box → DRAGGING
    → store the start pointer position and each object's start position
    → pointermove: newPos = startPos + (currentPointer - startPointer),
      in CANVAS coordinates
    → pointerup: one update per moved object, batched in a single message,
      ONE undo entry for the whole group

RESIZE
  pointerdown on a handle → RESIZING, record which handle
    → compute the new bounding box from the anchor (the opposite handle)
    → Shift → preserve the original aspect ratio
    → Alt   → resize about the centre
    → apply the scale factor to every selected object's geometry
    → enforce minimum 8×8; clamp below that. Never allow negative
      dimensions or a flipped box unless flipping is explicitly supported

ROTATE
  pointerdown on the rotate handle → ROTATING
    → angle = atan2(pointer - boundingBoxCentre)
    → Shift snaps to 15°
    → live degree readout near the cursor
    → rotation normalized to 0–359.99
```

**Marquee:** drag on empty canvas with the Select tool draws a rectangle on the interaction layer; on release, objects **fully contained** are selected.

**Resize semantics by type** (`FR-CANVAS-012`): text and sticky notes **reflow** text rather than scaling glyphs; freehand strokes scale their point geometry proportionally.

**Eraser** (`FR-CANVAS-006`): object eraser only. Hovering highlights objects in `--color-danger`; pointer-down-and-drag deletes everything touched. Deletion is a normal op and fully undoable. The pixel eraser that splits strokes is explicitly out of scope.

**Handle sizing:** minimum 8 px screen-space touch target regardless of zoom; 44 px on touch devices (`R-CANVAS-043`, `E-11`).

### UI/UX workstream

**Zone:** Board chrome and the overlay layer. Overlay rendering is renderer work, not design work — but the _visual specification_ of handles comes from the tokens.

**Skills:** `ui-ux-pro-max` for the selection affordances.

```bash
python3 $S "selection handles drag affordance" --domain ux -n 5
python3 $S "multi select bulk action" --domain ux -n 5
```

Selection box: 1 px `--color-accent` outline. Handles: white fill, 1 px `--color-accent` border, `--radius-sm`. Rotate handle sits above the top edge with a connecting line.

Properties panel for a multi-selection shows only properties common to all selected types; differing values render as **"Mixed"** (FLOWS §14.4).

Cursor changes per handle: `nwse-resize`, `nesw-resize`, `ns-resize`, `ew-resize`, and a rotate cursor.

### Motion workstream

**Frequency gate:** selection and dragging are the most frequent interactions in the entire product. **Nothing here animates.** No selection-box fade-in, no handle pop, no snap animation. The bounding box appears the instant the object is selected.

The only permitted motion is the eraser hover highlight — a 120 ms colour transition to `--color-danger` — because it is feedback that prevents accidental deletion, which is one of the valid purposes (`R-MOTION-003`). Persona B's stated fear is "clicking the wrong thing and deleting someone else's work", so this feedback earns its place.

### Tasks

1. Complete the interaction machine with all seven states and guarded transitions. Unit-test illegal transitions.
2. `pointercancel` handling wired to every capturing state.
3. `hitTest` with AABB pre-filter and per-type precise tests, including the `4/zoom` tolerance.
4. Rotated hit testing via local-space transformation.
5. Single select, shift+click toggle, click-empty-to-deselect.
6. Marquee: rectangle on the interaction layer, fully-contained selection on release.
7. Selection overlay rendering — bounding box, 8 resize handles, 1 rotate handle, minimum touch targets.
8. `DRAGGING` with canvas-space delta arithmetic and multi-object support.
9. `RESIZING` with anchor computation, Shift aspect lock, Alt from centre, 8×8 clamp.
10. Type-specific resize: stroke point scaling, text and sticky reflow.
11. `ROTATING` with 15° Shift snap, live degree readout, normalization.
12. Arrow-key nudge (1 px) and shift+arrow (10 px).
13. Delete via `Delete`/`Backspace`. Select-all via `Cmd+A` (all objects, not just visible). `Escape` deselects and returns to Select.
14. Eraser tool with hover highlight and drag-to-delete.
15. Multi-selection properties panel with "Mixed" value rendering.
16. `E-07`: batch drags of many objects into one operation.

> **Corrections applied during implementation.**
>
> - **Delete is NOT undoable in this phase**, though `FR-CANVAS-014` requires it. `HistoryManager` is Phase 6. Every mutation is routed through two batched store actions — `updateObjects` and `deleteObjects` — so Phase 6 has exactly one hook per operation type, with the pre-change objects still in hand to build inverse ops from. Nothing about those signatures needs to change. The `PHASE 6 SLOT` comments mark each site.
> - **Type-specific resize covers strokes only** (task 10). Text and sticky notes reflow rather than scaling glyphs, but neither type exists until Phase 5, so there is nothing to reflow and nothing to test. `applyBoxTransform` scales stroke point geometry and carries a marked branch for the Phase 5 types.
> - **Alignment guides are not in this phase.** FLOWS §8.2.3's MOVE flow mentions them, but they are `FR-CANVAS-020` `[P1]` and Appendix A assigns them to **Phase 5**. FLOWS is describing the eventual behaviour of the flow, not this phase's scope.
> - **New defect `D-6` — the marquee's layer.** FLOWS §8.2.3 says the marquee renders "on the overlay layer"; §14.3's layer table explicitly lists "the marquee rectangle" under **layer 2 (interaction)**. §14.3 is the authoritative layer specification and the more specific statement, so it wins: marquee on layer 2, selection box and handles on layer 3. Recorded in `RULES.md` §2.4.
> - **`ERASING` is added to the machine, and cannot be suspended by `PANNING`.** FLOWS §15.1's machine predates the eraser and excludes only `DRAWING` and text editing from pan entry. An erase is a destructive pointer drag; suspending it to pan would leave the user holding a live delete gesture while the board slides underneath them. `R-CANVAS-051`'s reasoning extends to it.
> - **Selection outranks the active tool in the properties panel.** §14.4 keys most rows on the tool and its last three on the selection, without saying which wins. A user who has just selected something wants to edit it, so a non-empty selection takes the panel.

### Files

```
packages/shared/src/geometry.ts                          # hit-test primitives, rotation, polyline distance
apps/web/src/features/canvas/geometry/{hitTest,bounds,transformSelection}.ts
apps/web/src/features/canvas/interaction/machine.ts
apps/web/src/features/canvas/interaction/handlers/{select,transform,erase}.ts
apps/web/src/features/canvas/interaction/{usePointer,useKeyboard}.ts
apps/web/src/features/canvas/renderer/{drawOverlay,drawInteraction,drawObjects,Renderer}.ts
apps/web/src/components/board/properties/{SelectionProperties.tsx,MixedValue.tsx}
apps/web/src/components/board/PropertiesPanel.tsx
apps/web/src/stores/boardStore.ts
tests/e2e/canvas-selection.spec.ts
```

Move, resize and rotate share one begin/update/end shape and one snapshot mechanism, so they live in a single `transform.ts` rather than three files that would be 80% identical.

### Tests

- Unit: every illegal machine transition throws or is rejected.
- Unit: `pointercancel` from each capturing state returns to `IDLE` and releases capture.
- Unit: hit test correctness for all seven types, including rotated objects.
- Unit: a 1 px line at 10% zoom is still hittable within 4 screen px.
- Unit: resize with Shift preserves the aspect ratio exactly; with Alt, the centre stays fixed.
- Unit: resize clamps at 8×8 and never produces negative dimensions.
- Unit: rotation normalizes to 0–359.99.
- Component: multi-select with differing fills shows "Mixed".
- Manual: drag 500 objects at once; confirm the interaction stays responsive.

### Exit gate

Every transform works correctly at 10% and 500% zoom. The machine cannot be forced into an illegal state. `pointercancel` never leaves the app stuck. A 1 px line is selectable at minimum zoom. Dragging 500 objects batches into one operation.

---

## Phase 5 — Shapes, sticky notes, text overlay editing

|                |                                |
| -------------- | ------------------------------ |
| **Days**       | 13–15                          |
| **Milestone**  | M1                             |
| **Depends on** | Phase 4                        |
| **Owner**      | Renderer owner + Product owner |

### Objective

Every remaining object type renders, is created by its tool, and edits correctly. Text editing uses a DOM textarea overlay — a decision that saves weeks and is not up for reconsideration.

### Requirements

| ID              | Priority | Requirement                                                                                 |
| --------------- | -------- | ------------------------------------------------------------------------------------------- |
| `FR-CANVAS-007` | P0       | Shape tools — `R` rect, `O` ellipse, `L` line, `A` arrow; Shift constrains, Alt from centre |
| `FR-CANVAS-008` | P0       | Sticky note (`N`) — 200×200 default, 8 colours, immediate edit mode, auto-shrink text       |
| `FR-CANVAS-009` | P0       | Text (`T`) — click to place, 8–128 px, bold/italic/alignment, discard if empty              |
| `FR-CANVAS-015` | P0       | Copy / cut / paste / duplicate, with new IDs                                                |
| `FR-CANVAS-019` | P1       | Context menu                                                                                |
| `FR-CANVAS-020` | P1       | Alignment guides — pink snap guides within 6 screen px, Ctrl disables                       |

### Flows

FLOWS §8.2.2 (place and edit a sticky note, all four steps), §14.4 (properties by context), §15.1 (the `EDITING_TEXT` state), `E-06` (paste of non-image data).

### Technical contract

**Object schemas** — TRD §3.3:

```ts
interface ShapeObject extends BaseObject {
  type: 'rect' | 'ellipse' | 'line' | 'arrow'
  stroke: string
  strokeWidth: number
  fill: string | 'none'
  cornerRadius?: number // rect only
  arrowStart?: boolean // arrow only
  arrowEnd?: boolean
}

interface StickyObject extends BaseObject {
  type: 'sticky'
  text: string // max 2000 chars
  color: string // one of the 8 palette colours
  fontSize: number | 'auto'
  textAlign: 'left' | 'center' | 'right'
}

interface TextObject extends BaseObject {
  type: 'text'
  text: string // max 5000 chars
  color: string
  fontSize: number // 8–128
  bold: boolean
  italic: boolean
  textAlign: 'left' | 'center' | 'right'
}
```

**The text overlay decision** — TRD D-6, FLOWS §8.2.2. This is the single biggest time-saver in the project:

> **Why an overlaid textarea instead of implementing a text cursor on canvas:** IME input, spellcheck, mobile keyboards, accessibility, text selection, and copy/paste all come free. Implementing a caret on canvas is weeks of work and will be worse. **Do not do it.** (anti-pattern `A-23`)

**Sticky note flow** — FLOWS §8.2.2:

```
1. Press `N`. Properties panel shows the 8 colours.
2. Click on the canvas.
   → a 200×200 note is created at the click point, centred on the cursor
   → the op is emitted immediately — the empty note is a real object
   → the note IMMEDIATELY enters edit mode: a transparent textarea is
     overlaid, positioned and scaled to match the note's screen rect,
     and focused
3. User types.
   → the overlay textarea holds the text; the canvas note renders it
     live beneath
   → debounced 300 ms: emit an update with the new text
4. Escape, click outside, or Tab
   → commit the final text, remove the overlay, select the note
   → if the note is still empty AND was created in this interaction,
     delete it silently — no empty notes on the board
```

The user should be able to click and type without a second action (`FR-CANVAS-008`).

**Text auto-shrink:** from 16 px down to 10 px to fit; beyond that the note scrolls internally and shows a fade indicator. Text centred vertically and horizontally by default.

**Empty text objects are discarded on blur** — never persist empty text (`FR-CANVAS-009`, anti-pattern `A-24`).

**Shape constraints:** click-drag defines the bounding box. **Shift** constrains to square, circle, or 45°-snapped line/arrow. **Alt/Option** draws from the centre outward.

**Copy/paste** — `FR-CANVAS-015`:

- `Cmd/Ctrl+C`, `X`, `V`, and `Cmd/Ctrl+D` for duplicate.
- Paste places objects at the pointer position; duplicate offsets by +16, +16 canvas px.
- **Pasted objects get new IDs. Never reuse an ID.**
- Cross-board and cross-tab paste works via a serialized JSON payload on the system clipboard.
- `E-06`: pasting plain text creates a text object at the pointer; other non-image data is ignored silently.

**Alignment guides** — `FR-CANVAS-020`: while dragging, show pink guides when an edge or centre aligns with another object's edge or centre within 6 **screen** pixels, and snap to it. Hold `Ctrl` to temporarily disable snapping. Guides render on the interaction layer and are checked only against non-selected objects within the viewport.

### UI/UX workstream

**Zone:** Board chrome. Dials 4/2/6.

```bash
python3 $S "inline text editing contenteditable" --domain ux -n 5
python3 $S "context menu right click" --domain ux -n 5
```

**Sticky palette** — the 8 frozen colours from PRD §15 (`R-UI-014`). Rendered as a swatch row in the properties panel with a selected-state ring.

**Context menu** (`FR-CANVAS-019`): right-click on an object gives Duplicate, Copy, Bring to front, Send to back, Change colour, Delete. Right-click on empty canvas gives Paste, Select all, Zoom to fit. Focus-trapped, `Escape` closes, arrow-key navigable (`R-A11Y-001`).

The text overlay textarea must be visually invisible but functionally complete — transparent background, no border, matching font metrics and alignment, and correct caret colour.

### Motion workstream

**Frequency gate:** placing objects and editing text are high-frequency. **No entrance animation on any object.** A sticky note appears at full size, immediately, in edit mode.

Permitted:

| Element                 | Animation                                                | Duration | Curve        |
| ----------------------- | -------------------------------------------------------- | -------- | ------------ |
| Context menu            | `opacity` + `scale(0.95)`→`1`, **origin at the pointer** | 150 ms   | `--ease-out` |
| Colour swatch `:active` | `scale(0.97)`                                            | 120 ms   | `--ease-out` |
| Alignment guide         | **none** — appears instantly                             | —        | —            |

The context menu is origin-aware — it scales from where the user right-clicked, not from its centre (`R-MOTION-034`).

Alignment guides must appear instantly. A guide that fades in is a guide that arrives after the user needed it.

### Tasks

1. Shape tools with click-drag bounding-box definition; Shift and Alt modifiers.
2. `drawRect`, `drawEllipse`, `drawLine`, `drawArrow` renderers, including corner radius and arrowheads.
3. Shape properties panel: fill (including "none"), stroke colour, stroke width, opacity, corner radius.
4. Sticky note tool: click places 200×200, drag defines a custom size.
5. The DOM text overlay — positioning, scaling to the object's screen rect, focus management, `z-index: 4`.
6. `EDITING_TEXT` machine state with all three exits (Escape, click-outside, Tab).
7. Live canvas text rendering beneath the overlay; 300 ms debounced update emission.
8. Text auto-shrink 16→10 px, then internal scroll with a fade indicator.
9. Empty-object discard on blur, for both sticky notes and text.
10. Text tool with font size (8–128), colour, bold, italic, alignment.
11. Copy / cut / paste / duplicate with new ID generation and clipboard JSON serialization.
12. `E-06` plain-text paste creating a text object.
13. Context menu, both variants, keyboard accessible.
14. Alignment guides with 6-screen-px threshold, snapping, and `Ctrl` to disable.
15. Word wrapping and text measurement helpers shared by sticky and text rendering.

> **Corrections applied during implementation.**
>
> - **Phase 5 necessarily delivers a slice of `FR-CANVAS-016`.** The context menu is specified to contain "Bring to front, Send to back", but z-order is `FR-CANVAS-016`, which Appendix A assigns to **Phase 9**. Shipping a menu with two dead entries is worse than implementing them, and `nextZIndex` already existed from Phase 3. Front and back land here; bring-forward, send-backward, the `]`/`[` shortcuts and generating a key BETWEEN two neighbours stay with the full requirement in Phase 9.
> - **A new `CREATING` machine state.** FLOWS §15.1's `DRAWING` covers freehand only. A shape drag has no point list, re-derives its whole geometry from two corners on every move, and changes meaning under Shift and Alt — folding it into `DRAWING` would mean one state with two incompatible payloads. Like `DRAWING` and `ERASING`, it cannot be suspended by `PANNING`.
> - **Alignment guides are skipped above 50 selected objects.** Behavioural before it is a performance decision: aligning the union box of hundreds of objects to one neighbour's edge is not something anyone is attempting, and `FR-CANVAS-020` describes placing an object beside another object.
> - **Text and sticky reflow-on-resize, deferred from Phase 4, is now live.** `applyBoxTransform`'s marked branch is filled: a sticky's `fontSize: 'auto'` re-fits on every resize, so the text reflows rather than the glyphs scaling.
> - **`ColorSwatch` labels are context-qualified.** The shape panel shows stroke and fill rows over the same ten colours; without a prefix every swatch in one row has an accessible name identical to its twin in the other, which satisfies `R-A11Y-002` on a technicality while telling a screen-reader user nothing.
> - **`SelectionProperties` became type-aware.** §14.4's "Selection (single) — that object's full property set" was only implemented for strokes in Phase 4, because strokes were the only type. Selecting a rectangle offered nothing but opacity. It now branches per kind and still collapses to opacity alone for a mixed-type selection, which is exactly §14.4's third row.
>
> **Deferred, and stated rather than quietly dropped:** `FR-CANVAS-015`'s "cross-BOARD paste" cannot be exercised — there is one board until Phase 8. The clipboard payload is board-agnostic, so it will work when boards exist; only the test is missing.

### Files

```
apps/web/src/features/canvas/renderer/shapes/{rect,ellipse,line,arrow,sticky,text}.ts
apps/web/src/features/canvas/renderer/textMetrics.ts
apps/web/src/features/canvas/interaction/handlers/{shape,sticky,text}.ts
apps/web/src/features/canvas/TextOverlay.tsx
apps/web/src/features/canvas/geometry/alignmentGuides.ts
apps/web/src/lib/clipboard.ts
apps/web/src/components/board/ContextMenu.tsx
apps/web/src/components/board/properties/{ShapeProperties,StickyProperties,TextProperties}.tsx
```

### Tests

- Unit: Shift constrains a rect to a square and a line to 45° increments.
- Unit: Alt draws from the centre.
- Unit: auto-shrink picks the largest size that fits, floor 10 px.
- Unit: word wrapping matches canvas text measurement.
- Unit: paste generates new IDs; no ID is ever reused.
- Component: a sticky note enters edit mode on placement with the textarea focused.
- Component: an empty sticky note is removed on blur.
- Component: an empty text object is never persisted.
- Manual: IME input works in the text overlay (verified with a CJK input method).

### Exit gate

All seven non-image object types render, create, edit and transform correctly. A sticky note is click-and-type with no second action. Empty text and empty notes never persist. Copy/paste works across two browser tabs.

---

## Phase 6 — Local undo and redo

|                |                   |
| -------------- | ----------------- |
| **Days**       | 16–17             |
| **Milestone**  | M1                |
| **Depends on** | Phase 5           |
| **Owner**      | Interaction owner |

> **Corrections applied during implementation.**
>
> - **The `applyAndEmit` / `applyRemoteOp` split is not in `boardStore.ts`.** The Files list puts it there, but the store is the _document_, and a store that knows about the history stack is a store the sync engine cannot reuse. The two paths live in `features/canvas/history/apply.ts` and `applyRemote.ts`, over one shared store action, `boardStore.applyOps(ops)`, which is the only place an op is turned into a mutation. That is also what makes the exit gate's "provably incapable" achievable: `applyRemote.ts` is a fifteen-line module that imports the store and nothing else, and a unit test reads its source and fails the build if an import of the history stack ever appears in it.
> - **`applyAndEmit` takes an optional pre-mutation reader.** TRD §8.2's `updateObject` sketch assumes the store still holds the previous values when the inverse is built. That is true for a stroke, a paste or a colour change, and false for the three gestures the user has to _see_ — drag, resize and rotate mutate the store on every `pointermove`, so by `pointerup` the origin is gone. Those three pass `interaction.origin`, the snapshot the gesture already keeps, as the reader. The alternative was a second record-only entry point, and two commit paths that must be kept in step is exactly the shape of bug `R-UNDO-001` is about.
> - **Forward ops for a finished gesture are DIFFED, not hand-built.** `diffOp(before, after)` emits an UPDATE naming only the keys that actually changed, which satisfies `R-UNDO-007` structurally rather than per call site, and makes a click that never became a drag produce no op and no entry. It compares arrays element-wise: a stroke's `points` is rebuilt on every transform, so a reference compare would report every stroke in a selection as changed.
> - **A click-placed sticky or text object records ONE entry, at commit, not at placement.** `placeAndEdit` creates the object without touching history and `commitTextEdit` pushes a single CREATE carrying the finished text. Recording the empty placeholder would cost two Ctrl+Zs for one note — one for the text, one for the note — and a third undoing a note the empty-discard rule had already thrown away.
> - **New defect `D-7`: TRD §8.4 has no row for the keyboard nudge.** Key repeat fires the handler about thirty times a second, so a two-second arrow press would be sixty entries. Resolved as the typing row — coalesced per burst on the same 1 s window, keyed on the selection. Recorded in `RULES.md` §2.4.
> - **`AT-41` is testable now, not only in Phase 9.** The exit gate defers it, but `applyRemoteOp` exists from this phase, so "A moves an object, B deletes it, A undoes" can be driven directly: the delete goes through the remote path and the undo must be a silent no-op. It is a unit test in `history.test.ts`. `AT-40` still needs two clients and stays in Phase 9.
> - **History is cleared on board unmount**, not only on reload. `R-UNDO-006` says the stack does not persist; a stack whose entries name objects on a board the user has left is worse than an empty one, because the first Ctrl+Z on the next board is a silent run of ten stale skips.

### Objective

Per-user undo built on inverse ops, structured now so that when remote operations arrive in Phase 9 the "undo reverted my teammate's work" bug is structurally impossible rather than merely avoided.

PRD risk `R-3` rates this High/High: _"Implement the inverse-op model in TRD §8 exactly. Do not invent a variant."_

### Requirements

| ID              | Priority | Requirement                                                                                 |
| --------------- | -------- | ------------------------------------------------------------------------------------------- |
| `FR-CANVAS-018` | P0       | Undo / redo, per-user and local, 100-entry depth, cleared on reload, no-op on stale entries |

### Flows

FLOWS §8.2.5 (undo/redo user-facing behaviour).

### Technical contract

**The model** — TRD §8.1, local inverse-op stacks:

```ts
interface HistoryEntry {
  forward: ClientOp[] // what the user did
  inverse: ClientOp[] // what undoes it
  label: string // for debugging and a future history panel
}

class HistoryManager {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private readonly MAX = 100

  push(entry: HistoryEntry) {
    this.undoStack.push(entry)
    if (this.undoStack.length > this.MAX) this.undoStack.shift()
    this.redoStack = [] // ANY new action clears redo. Always.
  }

  undo() {
    let attempts = 0
    while (this.undoStack.length && attempts++ < 10) {
      const entry = this.undoStack.pop()!
      if (!this.isApplicable(entry.inverse)) continue // stale: skip silently
      applyAndEmit(entry.inverse)
      this.redoStack.push(entry)
      return
    }
  }

  redo() {
    /* symmetric */
  }

  private isApplicable(ops: ClientOp[]) {
    return ops.every(op => op.type === 'CREATE' || store.objects.has(op.objectId))
  }
}
```

**Inverse op construction** — TRD §8.2:

| Forward op                 | Inverse op                                      |
| -------------------------- | ----------------------------------------------- |
| `CREATE(obj)`              | `DELETE(obj.id)`                                |
| `DELETE(obj)`              | `CREATE(snapshot of obj taken BEFORE deletion)` |
| `UPDATE(id, {fill:'red'})` | `UPDATE(id, {fill: <previous value>})`          |

**You must capture the previous values before applying the update.** This is the step everyone forgets (`R-UNDO-007`):

```ts
function updateObject(id: string, changes: Partial<BoardObject>) {
  const before = store.objects.get(id)
  if (!before) return
  // Capture ONLY the keys being changed — not the whole object
  const inverseChanges = Object.fromEntries(
    Object.keys(changes).map(k => [k, (before as any)[k]]),
  )
  const forward = { id: uuid(), type: 'UPDATE', objectId: id, payload: changes }
  const inverse = { id: uuid(), type: 'UPDATE', objectId: id, payload: inverseChanges }
  applyAndEmit(forward)
  history.push({ forward: [forward], inverse: [inverse], label: 'update' })
}
```

Capturing only the changed keys — rather than the whole object — is what keeps undo from clobbering a teammate's concurrent edit to a _different_ field.

**The five rules of collaborative undo** — TRD §8.3. This is the section PRD risk `R-3` refers to:

1. **Only your own ops enter your history stack.** Remote ops applied via `receiveOps` must never call `history.push`. **Enforce this with a distinct code path:** `applyRemoteOp` does not touch history; `applyAndEmit` does. (`R-UNDO-001`)
2. **An undo is emitted as a normal op.** Other clients see it as an ordinary change. There is no special "undo" message type.
3. **A multi-object action is one history entry.** Dragging 10 objects pushes one entry containing 10 forward and 10 inverse ops.
4. **A stale entry is skipped, not applied** — up to 10 skips per keypress.
5. **History does not survive a reload.** Deliberately not persisted.

**Grouping rules** — TRD §8.4:

| Action                   | Entries                                                      |
| ------------------------ | ------------------------------------------------------------ |
| One stroke               | 1                                                            |
| Drag 10 objects          | 1, containing 10 ops                                         |
| Delete a multi-selection | 1                                                            |
| Typing in a sticky note  | 1 per burst — coalesce updates within 1 s on the same object |
| Resize                   | 1, pushed on `pointerup`, never on `pointermove`             |
| Paste 5 objects          | 1                                                            |

**Redo clearing:** any new user action clears the redo stack. Always. No exceptions (`R-UNDO-008`).

### UI/UX workstream

**Zone:** Board chrome.

Undo/redo buttons sit bottom-left, ~88×40 px, `z-index: 20`, disabled when the corresponding stack is empty. Disabled state must be visually distinct and `aria-disabled` (`R-UI-024`).

```bash
python3 $S "undo redo affordance disabled state" --domain ux -n 5
```

### Motion workstream

**Frequency gate:** `Cmd+Z` is a keyboard-initiated action performed dozens of times per session. Rule `R-MOTION-002` is unambiguous: **never animate keyboard-initiated actions.**

**Undo and redo have no animation whatsoever.** The board simply changes. Any transition here would make the most-repeated recovery action in the product feel slow.

The buttons get the standard `:active` `scale(0.97)` at 120 ms, and a colour transition when moving between enabled and disabled.

### Tasks

1. `HistoryManager` with both stacks, `MAX = 100`, and redo clearing on push.
2. Inverse-op construction for all three op types, with the capture-before-mutate pattern.
3. **Two distinct code paths:** `applyAndEmit` (local, touches history) and `applyRemoteOp` (remote, never touches history). Establish this now, before Phase 9 exists.
4. Grouping for all six action types in the table.
5. Sticky-note typing coalescence within a 1-second window on the same object.
6. Staleness detection with the 10-skip cap.
7. `Cmd+Z` and `Cmd+Shift+Z` shortcuts, suppressed while a text input or the text overlay has focus (`R-A11Y-009`).
8. Undo/redo buttons with correct disabled states.
9. History depth cap with FIFO eviction.

### Files

```
apps/web/src/features/canvas/history/HistoryManager.ts
apps/web/src/features/canvas/history/inverseOps.ts
apps/web/src/features/canvas/history/grouping.ts
apps/web/src/components/board/UndoRedoControls.tsx
apps/web/src/stores/boardStore.ts        # applyAndEmit / applyRemoteOp split
```

### Tests

- Unit: `CREATE` inverts to `DELETE` and back.
- Unit: `UPDATE` inverse captures only the changed keys, not the whole object.
- Unit: `DELETE` inverse restores the full pre-deletion object.
- Unit: dragging 10 objects produces exactly one entry with 10 op pairs.
- Unit: a new action clears the redo stack.
- Unit: a stale entry is skipped and the next is tried, capped at 10 attempts.
- Unit: the stack caps at 100 with FIFO eviction.
- Unit: `applyRemoteOp` never calls `history.push` — assert with a spy.
- E2E `AT-42`: 10 actions, 10 undos, board returns to the starting state.
- E2E `AT-43`: 5 undos then 5 redos is identical to before.
- E2E `AT-44`: undo, new action, redo does nothing.

### Exit gate

100-step undo and redo work correctly for every action type. Grouping matches the table exactly. `applyRemoteOp` is provably incapable of touching history. `AT-42`, `AT-43` and `AT-44` pass. `AT-40` and `AT-41` become testable in Phase 9.

---

## Phase 7 — Auth REST, guards, token rotation

|                |                                              |
| -------------- | -------------------------------------------- |
| **Days**       | 18–20                                        |
| **Milestone**  | M2 — It persists                             |
| **Depends on** | Phase 1 (Phases 2–6 are independent of this) |
| **Owner**      | Product owner                                |

> **Corrections applied during implementation.**
>
> - **CI gained real Postgres and Redis service containers.** This phase is the first whose tests cannot be honest without a database — the list is almost entirely integration tests, and a mocked Prisma verifies none of what matters: the unique constraint on `emailLower`, the cascade that takes tokens with a user, the transaction that revokes a family atomically. The `quality` job now runs `prisma migrate deploy` against `postgres:15` and `redis:7`, mirroring `docker-compose.yml` so a CI failure reproduces locally through `scripts/dev-services.sh`.
> - **`GET /auth/me` returns the user on refresh, and a `PasswordResetToken` model was added.** The Files list and the §3.1 schema subset name only `User` and `RefreshToken`, but a single-use, 60-minute, hashed reset token needs a row of its own — putting `usedAt` on the user would allow exactly one outstanding reset ever.
> - **A `familyId` column on `RefreshToken`.** TRD §11.1 requires revoking "the entire token family" on reuse but the §3.1 model has no way to express a family. A self-referencing lineage column makes it one `updateMany`, rather than walking a parent chain of unbounded length while an attacker holds a live token.
> - **Registration deliberately does NOT hide `EMAIL_TAKEN`.** `R-SEC-008` governs login and password reset, where a generic response is what prevents enumeration. A signup form cannot be generic — FLOWS §3.1 branch 8b specifies the inline error and the "Log in instead" link explicitly — and every signup form in existence leaks this. Hiding it would break the flow without buying secrecy.
> - **Login compares against a dummy bcrypt hash when no account exists.** Without it a missing account returns in ~1 ms and a wrong password in ~250 ms, and that gap is a working enumeration oracle needing no error message, just a stopwatch. The integration suite asserts both responses are identical.
> - **New defect `D-8`: FLOWS §3.2 and §4 branch 3b both claim focus after a failed login.** Resolved in favour of §4 as the more specific rule, for that one branch only. Recorded in `RULES.md` §2.4.
> - **`/board/:boardId` is not yet guarded.** FLOWS §2.1 assigns it `requireBoardAccess`, which §2.3 defines in terms of board membership and roles — Phase 8's `Board` and `BoardMember`. There is no board data to protect yet, so gating it now would mean writing a guard against tables that do not exist and making the Phase 2–6 canvas suites authenticate for no benefit. It moves behind the real guard in Phase 8.
> - **`react-router-dom` v6 was replaced by `react-router` v7 during the phase.** v6 carries three moderate advisories, two of them **open redirect** — the exact bug class `nextParam.ts` exists to prevent. `pnpm audit`'s gate is high-and-above so they would not have blocked, but shipping known open-redirect CVEs in the authentication phase is incoherent. The upgrade is an import-specifier change; audit is now completely clean.
> - **The auth e2e suite stubs the API rather than driving the real server.** Deliberate, and it buys something a real server cannot: a refresh that takes 300 ms on demand. Against localhost the silent refresh finishes in single-digit milliseconds, so the "never flashes the login screen" test would pass whether or not the guard were correct. Real server behaviour is covered by 50 integration tests against real services.
>
> **Delivered with stated limits.**
>
> - **Google OAuth [P1] — linking logic verified, live round trip not.** No Google credentials exist in this repository and none can be created from it. The token exchange sits behind an injectable interface, so account linking, unverified-email refusal and the state/CSRF guard are all integration-tested against a real database; what is unverified is the HTTP call to `accounts.google.com` itself.
> - **Password reset [P1] — tokens real, delivery not.** Generation, hashing, single use, the 60-minute expiry and session invalidation are implemented and tested. `SMTP_URL` is unset and there is no mail provider, so the `Mailer` interface's development implementation logs the reset URL. Returning the token in the HTTP response "for development" was rejected outright: that is the shape of a production endpoint handing account-takeover tokens to anyone who knows an email address.
> - **S-07 Dashboard is a placeholder.** Boards CRUD is Phase 8. It exists so a successful login has somewhere to land, and uses the real PRD §8.3 empty-state copy rather than filler.

### Objective

A complete authentication system: registration, login, silent refresh with rotation and reuse detection, password reset, Google OAuth, and route guards that never flash the login screen. Plus the five auth screens, built to the form conventions that apply to every form in the product.

### Requirements

| ID            | Priority | Requirement                                                          |
| ------------- | -------- | -------------------------------------------------------------------- |
| `FR-AUTH-001` | P0       | Email + password registration                                        |
| `FR-AUTH-002` | P0       | Login, generic errors, 5-attempt lockout per 15 min                  |
| `FR-AUTH-005` | P0       | Session persistence, 30 days, silent refresh                         |
| `FR-AUTH-003` | P1       | Google OAuth, linking to an existing password account                |
| `FR-AUTH-004` | P1       | Password reset, single-use 60-minute token, invalidates all sessions |
| `FR-AUTH-007` | P1       | Logout                                                               |
| `FR-SET-001`  | P1       | Profile settings — name, avatar, password, delete account            |

Also implements **`E-17`**, which is the real requirement behind the dangling `FR-BOARD-041` reference (defect `D-1`, `RULES.md` §2.4).

### Flows

FLOWS §2.1 (route table), §2.2 (`requireAuth`, exact sequence), §3 (signup, all branches), §3.2 (validation rules), §3.3 (OAuth), §4 (login, deep-link preservation), §5 (password reset), §12.5 `E-17`.

### Technical contract

**Endpoints** — TRD §4.1:

| Method | Path                    | Body                             | Success                                    | Errors                                           |
| ------ | ----------------------- | -------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| POST   | `/auth/register`        | `{email, password, displayName}` | 201 `{user, accessToken}` + refresh cookie | 409 `EMAIL_TAKEN`, 422, 429                      |
| POST   | `/auth/login`           | `{email, password}`              | 200 `{user, accessToken}` + cookie         | 401 `INVALID_CREDENTIALS`, 429                   |
| POST   | `/auth/refresh`         | — (cookie)                       | 200 `{accessToken}` + rotated cookie       | 401 `INVALID_REFRESH`                            |
| POST   | `/auth/logout`          | —                                | 204                                        | —                                                |
| GET    | `/auth/me`              | —                                | 200 `{user}`                               | 401                                              |
| GET    | `/auth/google`          | —                                | 302 to Google                              | —                                                |
| GET    | `/auth/google/callback` | `?code`                          | 302 to client                              | 302 `?error=`                                    |
| POST   | `/auth/forgot-password` | `{email}`                        | **200 always**                             | 429                                              |
| GET    | `/auth/reset/validate`  | `?token`                         | 200 `{valid:true}`                         | 400 `TOKEN_INVALID`/`TOKEN_EXPIRED`/`TOKEN_USED` |
| POST   | `/auth/reset`           | `{token, password}`              | 200                                        | 400, 422                                         |

**Error envelope** — TRD §4, used by every endpoint in the product:

```jsonc
{
  "error": {
    "code": "BOARD_NOT_FOUND", // stable machine-readable code
    "message": "Board not found", // developer-facing, never shown raw
    "details": {}, // optional field-level errors
    "correlationId": "8f3a2b91", // matches the server log entry
  },
}
```

**Token strategy** — TRD §11.1, decision D-11:

| Token     | Storage                                                      | Lifetime         |
| --------- | ------------------------------------------------------------ | ---------------- |
| Access    | **In memory only** — a module variable, never `localStorage` | 15 min           |
| Refresh   | `httpOnly`, `Secure`, `SameSite=Lax` cookie, rotated on use  | 30 days          |
| WS ticket | In memory                                                    | 60 s, single use |

**Refresh rotation with reuse detection:** each refresh issues a new token and revokes the old one. If a revoked token is presented, that indicates theft — **revoke the entire token family and force re-login** (`R-SEC-006`).

**Prisma models** — TRD §3.1, the auth subset:

```prisma
model User {
  id            String   @id @default(uuid())
  email         String   @unique
  emailLower    String   @unique          // case-insensitive lookup
  passwordHash  String?                   // null for OAuth-only accounts
  displayName   String   @db.VarChar(40)
  avatarUrl     String?
  googleId      String?  @unique
  emailVerified Boolean  @default(false)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  ownedBoards   Board[]        @relation("BoardOwner")
  memberships   BoardMember[]
  operations    Operation[]
  refreshTokens RefreshToken[]

  @@index([emailLower])
}

model RefreshToken {
  id         String   @id @default(uuid())
  userId     String
  tokenHash  String   @unique              // store a hash, never the token
  expiresAt  DateTime
  revokedAt  DateTime?
  userAgent  String?
  createdAt  DateTime @default(now())

  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
}
```

**The `requireAuth` guard** — FLOWS §2.2. The sequence matters:

```
1. Is there an access token in memory?
   YES → proceed to route.
   NO  → step 2.

2. Attempt silent refresh: POST /api/auth/refresh (sends the httpOnly cookie).
   Render a full-screen branded spinner while this is in flight.
   Do NOT flash the login screen.
   A flash of login is a bug, not a cosmetic issue.

3. Refresh succeeds → store the new access token in memory → proceed.
   Refresh fails (401) → redirect to /login?next=<current-path-and-query>.

4. On successful login, read `next`, validate it is a same-origin relative
   path (reject anything starting with `//` or containing a scheme),
   and navigate there. If invalid or absent → /dashboard.
```

**Deep-link preservation** — FLOWS §4: a user sent to `/login?next=/board/abc123` lands on that board after login, not on the dashboard. _"Test this explicitly — it is the single most common regression in auth work."_

**Password rules** — `FR-AUTH-001`: minimum 8 characters, at least one letter and one number, maximum 128 (to bound bcrypt cost). Display name 1–40 characters, trimmed, non-empty after trim. Email unique, case-insensitive, RFC 5322 pragmatic subset. bcrypt cost 12.

**Rate limiting** — `FR-AUTH-002`: after 5 failed attempts for one email within 15 minutes, reject further attempts for that email for 15 minutes with a countdown. Plus 20 per 15 minutes per IP.

**Password reset** — FLOWS §5: the server always returns 200 regardless of whether the email exists. Token is single-use, 60-minute expiry. Success invalidates all sessions for that user. **Do not auto-log-in after a reset** — requiring an explicit login confirms the user knows the new password.

**`E-17` — session expiry while a board is open:** the socket stays valid for its lifetime. Refresh the token silently in the background. If the refresh fails, **keep the socket alive** and show a banner: "Your session expired. [Log in again]". Never lose their work. This is the behaviour the dangling `FR-BOARD-041` was pointing at.

### UI/UX workstream

**Zone:** Auth (S-02 … S-06). Dials **5 / 3 / 4**.

**Skills:** `ui-ux-pro-max`, `emil-design-eng`, `design-taste-frontend` (typography and colour only). **`gpt-taste` is forbidden here** — AIDA and hero grammar are wrong for a form (`R-SKILL-010`).

```bash
S=/root/.claude/skills/synced/ui-ux-pro-max/scripts/search.py
python3 $S "form validation inline error" --domain ux -n 5
python3 $S "password strength meter" --domain ux -n 5
python3 $S "focus states keyboard navigation" --domain web -n 5
```

**Form conventions — these apply to every form in the product** (FLOWS §3.2, rules `R-UI-058`, `R-UI-059`):

- **Never validate a field before the user has left it for the first time.** Validating on the first keystroke is hostile.
- Once a field has shown an error, **re-validate on every keystroke** so the error clears the moment it is fixed.
- **Submit is never disabled for validation reasons** — let the user click and show them what is wrong. It **is** disabled while a request is in flight.
- `Enter` in any field submits.
- Form-level errors appear above the submit button and receive focus for screen readers.
- **Typed values are preserved** on network failure.

**Validation copy** — must match FLOWS §3.2 exactly:

| Field        | Rule                            | Timing           | Copy                                                                     |
| ------------ | ------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| Email        | Non-empty                       | On submit        | "Enter your email."                                                      |
| Email        | Valid format                    | On blur + submit | "That doesn't look like an email address."                               |
| Password     | ≥ 8 chars, ≥1 letter, ≥1 number | Live checklist   | "Password needs at least 8 characters, including a letter and a number." |
| Display name | 1–40 after trim                 | On blur          | "Enter a name so others know who you are."                               |

Signup shows a live strength meter and a checklist: "8+ characters ✓ / a letter ✓ / a number ✗" — rendered with Phosphor `Check`/`X` glyphs, not emoji (`R-UI-012`).

**Login failure** (FLOWS §4): password field cleared, email kept, focus returns to password.

**S-06 OAuth callback** must never be visible for more than ~1 second. Past 5 seconds show "Still working…"; past 15 seconds fail over to S-03 with an error.

All copy comes from `strings.ts` (`R-UI-052`).

### Motion workstream

**Frequency gate:** logging in happens rarely — a few times a month. This is the "occasional" band, so standard animation is appropriate. But these are also anxiety-adjacent moments, so motion stays restrained.

| Element                 | Animation                               | Duration | Curve        |
| ----------------------- | --------------------------------------- | -------- | ------------ |
| Inline field error      | `opacity` + `translateY(-4px)`→`0`      | 150 ms   | `--ease-out` |
| Form-level error banner | `opacity` + `translateY(-8px)`→`0`      | 200 ms   | `--ease-out` |
| Submit button → loading | Content crossfade with `blur(2px)` mask | 200 ms   | `ease`       |
| Button `:active`        | `scale(0.97)`                           | 120 ms   | `--ease-out` |
| Route transition        | **None**                                | —        | —            |
| Strength meter fill     | `transform: scaleX()`                   | 200 ms   | `--ease-out` |

The button loading transition uses `emil-design-eng`'s blur-mask technique — without it you see two distinct states overlapping during the crossfade.

No route transition animation. A page transition on login makes the app feel slower than it is.

### Tasks

1. Prisma `User` and `RefreshToken` models; migration.
2. `AuthService`: register, login, bcrypt cost 12, generic errors.
3. JWT issuance; access token 15 min; refresh token hashed at rest.
4. Refresh rotation with reuse detection and family revocation.
5. Rate limiting: 5/15 min per email, 20/15 min per IP, Redis token bucket.
6. Password reset: token generation, single-use, 60-minute expiry, always-200 forgot endpoint, session invalidation on success.
7. Google OAuth: redirect, callback, account linking by email.
8. Auth middleware and the `assertAuthenticated` helper.
9. Client `authStore` with the in-memory access token; the API client with automatic refresh-on-401 and request replay.
10. `requireAuth` and `redirectIfAuthed` guards, with the branded spinner and no login flash.
11. `?next=` capture and same-origin validation.
12. S-02 Signup with the full validation table and all five response branches (201/409/422/429/network).
13. S-03 Login with all four branches, password clearing, focus return.
14. S-04 Forgot password: form state and confirmation state, resend disabled for 60 s with countdown.
15. S-05 Reset password with token validation on mount and all four token states.
16. S-06 OAuth callback with the timing thresholds.
17. S-16 Profile settings: display name, avatar, password change, delete account with typed confirmation.
18. `E-17` session-expiry banner.
19. Logout: clear session, clear in-memory caches, disconnect any socket cleanly first.

### Files

```
apps/server/src/services/AuthService.ts
apps/server/src/http/routes/auth.ts
apps/server/src/http/middleware/{auth.ts,rateLimit.ts,errorHandler.ts,validate.ts}
apps/server/src/lib/jwt.ts
apps/server/prisma/schema.prisma
apps/web/src/stores/authStore.ts
apps/web/src/lib/api.ts
apps/web/src/routes/guards.tsx
apps/web/src/routes/{Login,Signup,ForgotPassword,ResetPassword,OAuthCallback,Settings}.tsx
apps/web/src/features/auth/{useAuth.ts,api.ts,PasswordStrength.tsx}
apps/web/src/components/ui/{Input,Button,FormError,Spinner}.tsx
packages/shared/src/schemas/auth.ts
```

### Tests

- Integration: every endpoint, success and every documented error code.
- Integration: refresh rotation issues a new token and revokes the old.
- Integration: presenting a revoked refresh token revokes the whole family.
- Integration: 6th login attempt within 15 minutes is rejected with a countdown.
- Integration: forgot-password returns 200 for a non-existent email.
- Integration: reset invalidates all existing sessions.
- Integration: OAuth with an email matching a password account links rather than duplicating.
- Component: validation fires on blur, not on first keystroke; clears on keystroke after erroring.
- Component: submit stays enabled with invalid input, disables during flight.
- E2E: **deep-link preservation** — `/login?next=/board/abc` lands on the board.
- E2E: cold load with a valid refresh cookie shows the spinner, never the login screen.
- Security: `?next=//evil.com` and `?next=https://evil.com` are both rejected.

### Exit gate

Sign up, log out, log in, refresh the page, and remain logged in. A cold load with a valid cookie never flashes the login screen. Deep links survive login. Reset invalidates sessions. All auth integration tests pass.

---

## Phase 8 — Boards CRUD, dashboard, op persistence, snapshots

|                |               |
| -------------- | ------------- |
| **Days**       | 21–23         |
| **Milestone**  | M2            |
| **Depends on** | Phases 6, 7   |
| **Owner**      | Product owner |

### Objective

Boards persist. A user creates a board, draws, refreshes, and their work is still there. The dashboard lists boards with all seven states handled. The op log and snapshot machinery exist and work over REST, before any WebSocket complexity is added.

### Requirements

| ID             | Priority | Requirement                                              |
| -------------- | -------- | -------------------------------------------------------- |
| `FR-BOARD-001` | P0       | Create board, no naming dialog, straight into it         |
| `FR-BOARD-002` | P0       | Dashboard list with cards, sort, filter tabs             |
| `FR-BOARD-004` | P0       | Rename, inline, 1–80 chars, broadcasts                   |
| `FR-BOARD-005` | P0       | Soft delete with confirmation, ejects connected sessions |
| `FR-BOARD-003` | P1       | Thumbnails, 640×400 JPEG q0.7                            |
| `FR-BOARD-006` | P1       | Trash and restore, 30 days                               |
| `FR-BOARD-007` | P1       | Duplicate, no members or links copied                    |

### Flows

FLOWS §6 (dashboard: layout, card anatomy, all seven states, role-gated menu, and the create/rename/delete/trash sub-flows §6.5–§6.8), §2.3 STEP 5 (snapshot load).

### Technical contract

**Why an op log and not a mutable objects table** — TRD §3.2, decision D-3. You will be tempted to add an `Object` table and `UPDATE` rows. Do not:

| Property                         | Op log                          | Mutable table                        |
| -------------------------------- | ------------------------------- | ------------------------------------ |
| "What did I miss since seq 412?" | One indexed query               | Impossible without extra bookkeeping |
| Idempotent replay of an outbox   | Free — unique op id             | Requires separate dedupe             |
| Ordering authority               | Built in (`seq`)                | Needs a version column anyway        |
| Auditability / future history    | Free                            | Lost                                 |
| Write pattern                    | Append-only, no lock contention | Row-level contention on hot objects  |

The cost is that reading a board means replaying ops. Snapshots solve that — a well-understood trade.

**Prisma models** — TRD §3.1, the board subset:

```prisma
model Board {
  id             String    @id @default(uuid())
  name           String    @db.VarChar(80) @default("Untitled board")
  ownerId        String
  thumbnailUrl   String?
  currentSeq     Int       @default(0)      // last assigned op sequence number
  objectCount    Int       @default(0)      // denormalized, for load decisions
  deletedAt      DateTime?                  // soft delete
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  lastActivityAt DateTime  @default(now())

  owner      User          @relation("BoardOwner", fields: [ownerId], references: [id])
  members    BoardMember[]
  operations Operation[]
  snapshots  Snapshot[]
  shareLinks ShareLink[]

  @@index([ownerId, deletedAt])
  @@index([lastActivityAt])
}

model Operation {
  id         String   @id            // CLIENT-generated uuid — the idempotency key
  boardId    String
  seq        Int                     // server-assigned, monotonic per board
  type       OpType
  objectId   String
  payload    Json
  actorId    String?
  actorGuest String?
  createdAt  DateTime @default(now())

  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)
  actor User? @relation(fields: [actorId], references: [id], onDelete: SetNull)

  @@unique([boardId, seq])
  @@index([boardId, seq])
  @@index([boardId, objectId])
}

enum OpType { CREATE UPDATE DELETE }

model Snapshot {
  id        String   @id @default(uuid())
  boardId   String
  seq       Int                      // state as of this sequence number
  state     Json                     // { objects: BoardObject[] }
  createdAt DateTime @default(now())

  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@index([boardId, seq])
}
```

**Board endpoints** — TRD §4.2:

| Method | Path                     | Notes                                                                               |
| ------ | ------------------------ | ----------------------------------------------------------------------------------- |
| GET    | `/boards`                | `?filter=all\|owned\|shared\|starred&sort=&q=&cursor=` — cursor pagination, 24/page |
| POST   | `/boards`                | Creator becomes OWNER                                                               |
| GET    | `/boards/:id`            | 200 `{board, myRole, members[]}`                                                    |
| PATCH  | `/boards/:id`            | Owner only. Broadcasts `board:renamed`                                              |
| DELETE | `/boards/:id`            | Soft delete. Broadcasts `board:deleted`                                             |
| POST   | `/boards/:id/restore`    | Owner only, within 30 days                                                          |
| DELETE | `/boards/:id/permanent`  | `{confirmName}` must match exactly                                                  |
| POST   | `/boards/:id/duplicate`  | No members or links copied                                                          |
| GET    | `/boards/:id/access`     | Drives the FLOWS §2.3 guard                                                         |
| GET    | `/boards/:id/snapshot`   | Snapshot + tail ops, merged server-side                                             |
| GET    | `/boards/:id/operations` | `?sinceSeq=&limit=` — reconnect gap-fill fallback                                   |
| PUT    | `/boards/:id/thumbnail`  | multipart, client-rendered JPEG                                                     |

**Snapshot strategy** — TRD §3.4:

| Rule           | Value                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------- |
| When to create | Every 500 ops, and on the last client leaving                                               |
| How            | Replay from the previous snapshot forward, never from seq 0                                 |
| Retention      | Latest 3 per board                                                                          |
| Op retention   | Keep all ops. They are small and cheap                                                      |
| Load path      | `latest snapshot` + `ops WHERE seq > snapshot.seq`                                          |
| Generation     | **Background job, not on the request path.** If it fails, loading still works — just slower |

**Create board flow** — FLOWS §6.5:

```
Click "+ New board"
  → button shows a spinner. Do NOT navigate optimistically to a board
    that might fail to create
  → POST /api/boards { name: "Untitled board" }
  → 201 { boardId }
  → navigate to /board/:boardId
  → the header title is auto-focused and text-selected so the user can
    immediately type a real name without clicking anything
  → FAILURE: toast "Couldn't create the board. Try again."
    Button returns to idle. Stay on the dashboard.
```

`E-16`: the button disables on first click. One board, not two.

### UI/UX workstream

**Zone:** Product chrome (S-07, S-08). Dials **5 / 3 / 5**. Framer Motion is **permitted here**, lazy-loaded (`R-SKILL-060`).

**Skills:** `ui-ux-pro-max`, `emil-design-eng`, `framer-motion-animator`. **`gpt-taste` and `high-end-visual-design` are forbidden** — no bento grids or hero treatments on a file browser.

```bash
python3 $S "dashboard card grid empty state" --domain ux -n 5
python3 $S "skeleton loading shimmer" --domain ux -n 5
python3 $S "list virtualization" --domain web -n 5
```

**Dashboard layout** — FLOWS §6.1: header with logo, search and "+ New board" and avatar menu; left sidebar with All / Owned / Shared / Starred / Trash / Settings; content area with tabs, sort dropdown and grid/list toggle.

**Card anatomy** — FLOWS §6.2: 16:10 lazy-loaded thumbnail with shimmer skeleton, placeholder graphic when the board is empty, `⋮` menu on hover/focus, name truncated to one line, star toggle, relative time with absolute time in `title`, up to 4 member avatars plus overflow.

**All seven dashboard states** — FLOWS §6.3, and every one is required (`R-UI-050`):

| State                   | Rendering                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Loading                 | **8 skeleton cards with correct dimensions and shimmer. No spinner** — skeletons prevent layout shift (`R-UI-051`) |
| Loaded                  | Grid of cards                                                                                                      |
| Empty, never had boards | "Nothing here yet" + "Create your first board and invite your team." + "New board"                                 |
| Empty, filter           | "No boards match that filter" + "Clear filter"                                                                     |
| Empty, search           | "No boards found for '{query}'" + "Clear search"                                                                   |
| Error                   | Inline error card + "Retry". Sidebar and header stay functional                                                    |
| Partial error           | Cards render with placeholder thumbnails. **Do not fail the whole page for a thumbnail**                           |

**Role-gated card menu** — FLOWS §6.4: Rename, Share and Move-to-trash are owner-only; Leave board is non-owner-only.

Seed data uses realistic board names — "Q3 Retrospective", "Onboarding Flow v2" — not "Test Board 1" (`R-UI-060`).

### Motion workstream

**Frequency gate:** the dashboard is visited occasionally, a few times a day. This is the band where standard animation is appropriate, and it is the one place in the product where Framer Motion earns its bundle cost.

| Element          | Animation                                                                                  | Duration              | Curve        |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------- | ------------ |
| Card grid entry  | Stagger, `opacity` + `translateY(8px)`→`0`                                                 | 300 ms, 40 ms stagger | `--ease-out` |
| Card hover       | `box-shadow` + `border-color` only — **no scale** (`R-UI-021`)                             | 150 ms                | `ease`       |
| Card delete      | `opacity` + collapse                                                                       | 200 ms                | `--ease-out` |
| Card restore     | Reverse of delete                                                                          | 200 ms                | `--ease-out` |
| Menu popover     | `opacity` + `scale(0.95)`→`1`, **origin at the trigger**                                   | 150 ms                | `--ease-out` |
| Modal            | `opacity` + `translateY(8px)`, **origin centre** (modals are exempt from origin-awareness) | 200 ms                | `--ease-out` |
| Skeleton shimmer | `transform: translateX()` loop                                                             | 1.2 s                 | `linear`     |

Stagger caps at the first ~12 cards; beyond that everything appears at once. A 50-card stagger at 40 ms is a two-second wait (`R-MOTION-039`).

Card hover must not scale — scaling shifts layout and makes the grid jitter under the cursor (anti-pattern `A-70`).

### Corrections to this phase, found while building it

Recorded here rather than in the delivered specs (`R-PREC-020`). Each blocking one also has a row in the `RULES.md` §2.4 defect register.

**1. Phase 8 is split into two pull requests.** Nineteen tasks across two unrelated workstreams — server persistence and the dashboard UI — would land as roughly 7,000 lines in one review, against the ~400-line guidance in `R-GIT-003`. **8a** is tasks 1-8: models, services, endpoints, client persistence and board load, with `AT-10` as its gate. **8b** is tasks 9-19: the dashboard, Trash, thumbnails and the UI primitives they need.

**2. `BoardMember` and the `Role` enum land in Phase 8, not Phase 12.** The model list above omits them, but `GET /boards/:id` is specified to return `myRole`, and the owner needs a membership row from the moment the board is created — otherwise members, sharing and role changes all have to special-case one participant. Sharing itself (invites, share links) stays in Phase 12.

**3. `DELETE /boards/:id/permanent` is implemented as `POST /boards/:id/permanent-delete`** — defect `D-9`. A DELETE with a required body is unreliable in transit, and a confirmation that can be dropped is not a confirmation. Every other path in the TRD §4.2 table is implemented verbatim.

**4. `objectCount` needs the same treatment as `seq`** — defect `D-10`. `R-SYNC-013` names only the sequence number, but the read-then-write race is identical for any denormalised counter, and the concurrency test caught it losing 11 objects out of 79.

**5. An undo must be re-emitted with a fresh op id** — defect `D-11`. Otherwise the second undo of the same entry is re-acked as a duplicate and never reaches the database.

**6. `/board/:boardId` gets its guard, with the board-level half inside the route.** FLOWS §2.1 assigns `requireBoardAccess`; `RequireAuth` supplies the session and the route itself renders S-19/S-20 from the load result rather than redirecting. One request then answers both "may I?" and "what is on it?", which a guard could not do without asking the server anyway.

**7. A non-uuid board id is a DEV-only scratch board.** No fetch, no outbox, an empty document — which is what lets the Phase 2-6 canvas suites drive the renderer without a database, and `pnpm dev` work before you have signed in. In production the id goes to the server, which answers 404.

**8. Vitest is split into `unit` and `integration` projects.** The integration files share one Postgres and one Redis and truncate between cases; run in parallel they delete each other's rows. The integration project runs in a single fork, so the 24 pure files keep their parallelism.

**Deferred from 8a and stated rather than quietly dropped:** thumbnails (task 18) need the dashboard to display them; `board:renamed` / `board:deleted` broadcasts (tasks in FR-BOARD-004/005) need the Phase 9 socket; the snapshot-on-last-client-leaving trigger needs rooms, so only the every-500-ops trigger exists.

### Tasks

1. Prisma `Board`, `Operation`, `Snapshot` models and migration. Replace the Phase 1 seed stub with one that loads `fixtures/stress-board.json` into the database, and drop `--skip-generate` from `db:migrate` now that models exist.
2. `BoardService`: create, list with cursor pagination, rename, soft delete, restore, permanent delete, duplicate.
3. `OpService`: append op with transactional seq assignment; the same code path the socket will use in Phase 9.
4. `SnapshotService`: generate every 500 ops as a background job; retain 3; load path merging snapshot + tail ops.
5. `GET /boards/:id/snapshot` returning `{objects[], seq, meta}`.
6. `GET /boards/:id/operations?sinceSeq=` for gap fill.
7. Client persistence: ops emitted over REST for now; the client applies them optimistically and reconciles.
8. Board load: fetch snapshot, apply, set `lastAppliedSeq`.
9. Dashboard route with TanStack Query, cursor pagination, and all seven states.
10. Board card with lazy thumbnails, skeletons, role-gated menu.
11. Sort (last edited / created / name) and filter tabs (All / Owned / Shared / Starred).
12. Search with debounce and the empty-search state.
13. Create board sub-flow with double-click protection (`E-16`) and title auto-focus on arrival.
14. Inline rename from the card and from the board header, with optimistic update and revert on failure.
15. Delete confirmation modal, animate-out, and an 8-second "Undo" toast.
16. Trash view with days-remaining, restore, and typed-name permanent delete.
17. Duplicate.
18. Thumbnail generation — 640×400 JPEG q0.7, bounding box of all objects with 5% padding, on session end or every 5 minutes; static placeholder for empty boards.
19. `E-19`: simultaneous renames — last write wins, both see the final name.

### Files

```
apps/server/src/services/{BoardService,OpService,SnapshotService}.ts
apps/server/src/http/routes/boards.ts
apps/server/src/jobs/snapshotJob.ts
apps/web/src/routes/{Dashboard,Trash}.tsx
apps/web/src/features/boards/{BoardCard,BoardGrid,BoardCardMenu,useBoards,api}.tsx
apps/web/src/features/boards/{DeleteBoardModal,RenameInline}.tsx
apps/web/src/components/ui/{Skeleton,EmptyState,Dropdown,Modal,Toast}.tsx
apps/web/src/features/canvas/thumbnail.ts
packages/shared/src/schemas/board.ts
```

### Tests

- Integration: every board endpoint, including authorization failures.
- Integration: soft delete hides from list; restore returns it with content and membership intact.
- Integration: permanent delete requires an exact name match.
- Integration: duplicate copies objects but no members or share links.
- Integration: snapshot generation at 500 ops; load path merges snapshot + tail correctly.
- Integration: op append assigns monotonic gap-free seq under concurrent requests.
- Component: all seven dashboard states render.
- Component: double-clicking "New board" creates one board.
- E2E **`AT-10`**: draw, refresh, everything is there in the same position and z-order.
- E2E **`AT-11`**: draw, close the browser, reopen — everything is there.
- E2E **`AT-13`**: a 5,000-object board loads in under 3 s and is interactive.

### Exit gate

A user signs up, creates a board, draws, refreshes, and their work is intact — `AT-10` passes. The dashboard handles all seven states. A 5,000-object board loads under 3 seconds. Snapshots generate without blocking requests.

---

## Phase 9 — WebSocket gateway, rooms, op broadcast, sequence ordering

|                |                                         |
| -------------- | --------------------------------------- |
| **Days**       | 24–27                                   |
| **Milestone**  | M3 — It syncs                           |
| **Depends on** | Phase 8, and genuinely solid Phases 2–6 |
| **Owner**      | Sync owner                              |

> ### Read this before starting
>
> From TRD §16: **"This is where the project either succeeds or turns into a swamp. Do not start it until stages 2–8 are genuinely solid. Debugging a sync bug on top of a shaky renderer means you cannot tell which layer is lying to you, and you will lose days to it."**
>
> If Phase 2's layering is wrong, or Phase 6's `applyRemoteOp` path is not properly separated, **go back and fix that first**. Everything in this phase assumes those foundations hold.

### Objective

Two browser windows show each other's changes live and converge to identical state. The op log becomes authoritative over the wire, with server-assigned sequence numbers, idempotency, ordered application and gap handling.

### Requirements

| ID              | Priority | Requirement                                                |
| --------------- | -------- | ---------------------------------------------------------- |
| `FR-RT-001`     | P0       | Live object sync, p95 250 ms, hard ceiling 500 ms          |
| `FR-RT-002`     | P0       | Optimistic local application with rollback on rejection    |
| `FR-RT-007`     | P0       | Concurrent edit resolution                                 |
| `FR-RT-012`     | P0       | Persistence guarantee — ack only after durable persistence |
| `FR-CANVAS-016` | P1       | Z-order — fractional index, not array position             |

### Flows

FLOWS §2.3 STEP 5 (the parallel load ordering rule), §9.1 (a second user joins), §9.3 (concurrent edit matrix), §15.3 (object lifecycle).

### Technical contract

**Connection lifecycle** — TRD §5.1:

```
Client                                    Server
  ├─ WSS connect to /ws?boardId=X ──────────►│
  │   Authorization via:                     │
  │     a) Sec-WebSocket-Protocol bearer     ├─ verify access token OR
  │        subprotocol carrying the token    │   guest identity + share token
  │     b) or a short-lived ticket from      ├─ resolve role via PermissionService
  │        POST /api/ws/ticket               ├─ reject → close(4001, "unauthorized")
  │                                          │
  ├─ { t: "join", boardId, sinceSeq } ──────►│
  │                                          ├─ add socket to room(boardId)
  │◄─ { t: "join_ack", seq, role, users[],   ┤
  │      sessionId, colour } ────────────────┤
  │◄─ { t: "op_batch", ops[] } ──────────────┤  (only if sinceSeq < currentSeq)
  │                                          │
  ├─ { t: "ping" } every 25 s ──────────────►│
  │◄─ { t: "pong" } ─────────────────────────┤
```

**Heartbeat** (`R-SYNC-032`): the client pings every 25 s. If no pong within 10 s, treat the connection as dead and reconnect. **Do not rely on the socket's `close` event — a half-open TCP connection can hang for minutes.** The server terminates any socket silent for 60 s.

**The message envelope** — TRD §5.2. Keys are terse because these fly at 20 Hz per user:

```ts
type ClientMessage =
  | { t: 'join'; boardId: string; sinceSeq: number }
  | { t: 'op'; op: ClientOp }
  | { t: 'op_batch'; ops: ClientOp[] }
  | { t: 'cursor'; x: number; y: number }
  | { t: 'sel'; ids: string[] }
  | { t: 'stroke'; id: string; pts: number[]; done: boolean }
  | { t: 'xform'; ids: string[]; dx: number; dy: number }
  | { t: 'ping' }

type ServerMessage =
  | {
      t: 'join_ack'
      seq: number
      role: Role
      sessionId: string
      colour: string
      users: PresenceUser[]
    }
  | { t: 'op_batch'; ops: ServerOp[] }
  | { t: 'ack'; ids: string[]; seqs: number[] }
  | { t: 'nack'; id: string; code: string; message: string }
  | { t: 'presence_join'; user: PresenceUser }
  | { t: 'presence_leave'; sessionId: string }
  | { t: 'cursor'; sessionId: string; x: number; y: number }
  | { t: 'sel'; sessionId: string; ids: string[] }
  | { t: 'stroke'; sessionId: string; id: string; pts: number[]; done: boolean }
  | { t: 'xform'; sessionId: string; ids: string[]; dx: number; dy: number }
  | { t: 'board_renamed'; name: string }
  | { t: 'board_deleted' }
  | { t: 'role_changed'; role: Role }
  | { t: 'access_revoked' }
  | { t: 'pong' }

interface ClientOp {
  id: string // client-generated uuid — the idempotency key
  type: 'CREATE' | 'UPDATE' | 'DELETE'
  objectId: string
  payload: unknown // full object for CREATE, PARTIAL for UPDATE, {} for DELETE
}

interface ServerOp extends ClientOp {
  seq: number
  actorSessionId: string
}
```

**Server-side op handling** — TRD §5.4. Implement these seven steps in this order, with no shortcuts:

```ts
async function handleOp(session: Session, op: ClientOp) {
  // 1. AUTHORIZE — every single message, no exceptions
  if (session.role === 'VIEWER') {
    return send(session, {
      t: 'nack',
      id: op.id,
      code: 'FORBIDDEN',
      message: 'View-only access',
    })
  }

  // 2. VALIDATE against the Zod schema for op.type
  const parsed = OpSchema.safeParse(op)
  if (!parsed.success) {
    return send(session, {
      t: 'nack',
      id: op.id,
      code: 'INVALID_OP',
      message: 'Malformed operation',
    })
  }

  // 3. RATE LIMIT — token bucket in Redis, 100 ops/sec per session
  if (!(await rateLimiter.consume(session.id))) {
    return send(session, {
      t: 'nack',
      id: op.id,
      code: 'RATE_LIMITED',
      message: 'Slow down',
    })
  }

  // 4. IDEMPOTENCY — the client may resend after a reconnect
  const existing = await db.operation.findUnique({ where: { id: op.id } })
  if (existing) {
    return send(session, { t: 'ack', ids: [op.id], seqs: [existing.seq] })
  }

  // 5. ASSIGN SEQ AND PERSIST — atomically
  const seq = await db.$transaction(async tx => {
    const board = await tx.board.update({
      where: { id: session.boardId },
      data: { currentSeq: { increment: 1 }, lastActivityAt: new Date() },
      select: { currentSeq: true },
    })
    await tx.operation.create({
      data: {
        id: op.id,
        boardId: session.boardId,
        seq: board.currentSeq,
        type: op.type,
        objectId: op.objectId,
        payload: op.payload,
        actorId: session.userId,
        actorGuest: session.guestId,
      },
    })
    return board.currentSeq
  })

  // 6. ACK the sender FIRST — they are waiting to clear their outbox
  send(session, { t: 'ack', ids: [op.id], seqs: [seq] })

  // 7. BROADCAST to everyone else in the room (and via Redis pub/sub to
  //    sessions on other server instances)
  broadcastExcept(session.boardId, session.id, {
    t: 'op_batch',
    ops: [{ ...op, seq, actorSessionId: session.id }],
  })
}
```

> **On step 5:** the `increment` inside a transaction is what makes `seq` monotonic and gap-free under concurrency. Postgres serializes the row update, so two simultaneous ops cannot receive the same sequence number. **Do not compute the next seq with a `SELECT MAX(seq)` outside a transaction — that is a race condition waiting to happen.** (`R-SYNC-013`, anti-pattern `A-30`)

**Batching** — TRD §5.5: the client batches ops emitted within one animation frame into a single `op_batch`. The server batches broadcasts on a 16 ms per-room timer — with 20 users that turns 20 messages into 1. **Never batch a `nack`** — errors go out immediately.

**Close codes** — TRD §5.6:

| Code | Meaning                             | Client reaction                                                  |
| ---- | ----------------------------------- | ---------------------------------------------------------------- |
| 1000 | Normal                              | No reconnect                                                     |
| 1001 | Going away (page unload)            | No reconnect                                                     |
| 1006 | Abnormal (network)                  | Reconnect with backoff                                           |
| 4001 | Unauthorized                        | Do **not** reconnect. Refresh the token, then reconnect **once** |
| 4003 | Forbidden (role revoked)            | Do not reconnect. Show S-17                                      |
| 4004 | Board not found / deleted           | Do not reconnect. Show S-18/S-19                                 |
| 4029 | Rate limited / too many connections | Reconnect after 30 s                                             |

**The resolution algorithm** — TRD §6.2:

```
State is a Map<objectId, BoardObject> plus a Set<objectId> of tombstones.

applyOp(op):
  switch (op.type):

    CREATE:
      if tombstones.has(op.objectId): return          // deleted; never resurrect
      if objects.has(op.objectId):    return          // duplicate; idempotent
      objects.set(op.objectId, op.payload)

    UPDATE:
      if tombstones.has(op.objectId): return          // delete wins
      const existing = objects.get(op.objectId)
      if (!existing) return                            // unknown object; log + ignore
      // FIELD-LEVEL MERGE: only the fields present in the payload are replaced
      objects.set(op.objectId, { ...existing, ...op.payload })

    DELETE:
      objects.delete(op.objectId)
      tombstones.add(op.objectId)

  lastAppliedSeq = op.seq
```

Three properties you must be able to explain in a code review: **commutative** for disjoint objects, **idempotent**, **convergent**.

> `UPDATE` merges only the fields present in the payload rather than replacing the whole object. This is what allows "A moves it, B recolours it" to preserve both changes. **Always send partial payloads on update.** Sending the full object turns every concurrent edit into a lost update. (`R-CONV-002`, anti-pattern `A-33`)

**Ordered application and gap handling** — TRD §6.3:

```ts
private pendingOps = new Map<number, ServerOp>()

receiveOps(ops: ServerOp[]) {
  for (const op of ops) {
    if (op.seq <= this.lastAppliedSeq) continue        // duplicate
    this.pendingOps.set(op.seq, op)
  }
  // drain contiguously
  while (this.pendingOps.has(this.lastAppliedSeq + 1)) {
    const next = this.pendingOps.get(this.lastAppliedSeq + 1)!
    this.pendingOps.delete(next.seq)
    this.applyOp(next)
  }
  // a gap that persists means we missed messages
  if (this.pendingOps.size > 0) {
    this.scheduleGapFill()   // debounced 500 ms → GET /operations?sinceSeq=
  }
}
```

**Fractional z-indexing** — TRD §6.4, decision D-8. Integer `zIndex` means inserting between two objects requires renumbering everything above — an O(n) op storm. Instead `zIndex` is a **string key** ordered lexicographically:

```
Object A: "a0"
Object B: "a1"
Insert between: "a0V"        // lexicographically between "a0" and "a1"
```

Use the `fractional-indexing` npm package. New objects get a key after the current maximum. "Bring to front" generates after the max; "send to back" before the min. Two users reordering simultaneously produce two valid distinct keys, so nothing breaks. **Sort once per object-set change, not every frame** — cache the sorted array and invalidate on create/delete/z-change (`R-CONV-009`).

**The board load ordering rule** — FLOWS §2.3 STEP 5. This is the rule that prevents the classic flicker bug (`R-SYNC-035`):

```
Load content and connect, IN PARALLEL:
  a. GET /api/boards/:boardId/snapshot  → { objects[], seq, meta }
  b. Open the WebSocket and send `join` with { boardId, sinceSeq: 0 }

  Buffer any incoming ops from (b) until (a) resolves, then:
    - Apply the snapshot.
    - Replay buffered ops whose seq > snapshot.seq.
    - Drop buffered ops whose seq <= snapshot.seq (already included).

  This ordering rule is what prevents the classic "object flickers in
  then disappears" bug. Do not deviate from it.
```

**Object lifecycle** — FLOWS §15.3:

```
   (user action)
        │
        ▼
   ┌─────────┐  emit op   ┌──────────┐  server ack  ┌───────────┐
   │ DRAFTED │──────────► │ PENDING  │────────────► │ COMMITTED │
   └─────────┘            └──────────┘              └───────────┘
        │                       │                         │
   Escape/cancel          server reject              delete op
        ▼                       ▼                         ▼
   ┌──────────┐           ┌──────────┐              ┌──────────┐
   │DISCARDED │           │ROLLED    │              │ DELETED  │
   │(no trace)│           │BACK      │              │(tombstone│
   └──────────┘           │+ toast   │              │ retained)│
                          └──────────┘              └──────────┘
```

Deleted objects keep a tombstone in memory for the session so a late-arriving update is correctly ignored rather than resurrecting the object.

**Concurrent edit matrix** — `FR-RT-007`, FLOWS §9.3. These outcomes are correct behaviour, not errors:

| A does           | B does           | Result                               | User sees an error?                                                      |
| ---------------- | ---------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| Moves X          | Moves Y          | Both apply                           | No conflict                                                              |
| Moves X          | Recolours X      | Both apply — different fields        | No                                                                       |
| Sets X fill red  | Sets X fill blue | Later server seq wins                | The loser sees the colour change. **Accepted**                           |
| Deletes X        | Moves X          | X stays deleted, the move is dropped | The object vanishes mid-drag. Snap the drag to an end, show **no error** |
| Deletes X        | Deletes X        | Idempotent no-op                     | No                                                                       |
| Creates a stroke | Creates a stroke | Both exist, ordered by seq           | No                                                                       |
| Reorders z       | Reorders z       | Fractional indexing keeps both valid | No                                                                       |

### UI/UX workstream

**Zone:** Board chrome — only the connection indicator is new UI in this phase.

The header shows exactly one connection state (`FR-RT-009`, fully implemented in Phase 11). For this phase, implement Connected (green dot, no text) and Connecting (amber pulsing dot + "Connecting…").

**Optimistic rollback UI** (`FR-RT-002`): when the server nacks, remove the object locally, remove its undo entry, and show a non-blocking toast — "That change couldn't be saved." with an "Undo" action. Copy verbatim from `strings.ts`.

### Motion workstream

**Nothing about sync animates.** Remote objects appear instantly when their op is applied. There is no fade-in, no highlight pulse, no "someone else did this" flourish.

This is a deliberate decision. A remote object arriving with a 300 ms fade is a remote object the user sees 300 ms late, and at 5,000 objects the compositing cost is real. Remote changes must feel like they were always there.

The one exception: the connection indicator's amber "connecting" dot pulses — a 1.2 s `opacity` loop. It is status, not decoration, and it is the only continuous animation permitted in the board chrome.

### Tasks

1. WebSocket gateway with upgrade handling and handshake authentication.
2. `POST /api/ws/ticket` — 60-second single-use ticket.
3. `Session` and `RoomManager`: per-board socket registry, join/leave, broadcast, `broadcastExcept`.
4. Heartbeat: server-side 60 s termination, client-side 25 s ping with 10 s pong timeout.
5. Full `ClientMessage`/`ServerMessage` types in `packages/shared/src/protocol.ts`, with Zod schemas.
6. `handleOp` — all seven steps, in order.
7. Transactional seq assignment. **Load-test it with concurrent writers and assert monotonic gap-free sequences.**
8. Idempotency check and re-ack path.
9. Per-room 16 ms broadcast batching.
10. Redis pub/sub fan-out, written now even though v1 runs a single instance (TRD §15.2).
11. Close codes and their client reactions.
12. Client `SocketClient`: connect, authenticate, heartbeat, message dispatch.
13. Client `SyncEngine`: `receiveOps` with ordered draining, duplicate rejection, gap buffering and debounced gap fill.
14. `applyOp` with tombstones. Wired to `applyRemoteOp` — the path that never touches history.
15. Optimistic local apply with rollback on nack.
16. Fractional z-indexing with the `fractional-indexing` package; cached sorted array with invalidation.
17. Z-order commands: bring to front/forward, send backward/to back, via context menu and `]`, `Cmd+]`, `[`, `Cmd+[`.
18. The parallel snapshot + socket load with the buffering rule.
19. `E-13`: unknown object id — log, ignore, request a fresh snapshot after 3 occurrences in a minute.
20. Connection indicator (Connected and Connecting states).

### Files

```
apps/server/src/ws/{gateway.ts,RoomManager.ts,Session.ts}
apps/server/src/ws/handlers/{op.ts,join.ts}
apps/server/src/lib/redis.ts
apps/server/src/http/routes/ws.ts
apps/web/src/features/sync/{SocketClient.ts,SyncEngine.ts,protocol.ts}
apps/web/src/features/canvas/geometry/zIndex.ts
apps/web/src/components/board/ConnectionIndicator.tsx
packages/shared/src/protocol.ts
packages/shared/src/schemas/op.ts
```

### Tests

- Socket: every message type, both directions.
- Socket: a viewer's op is nacked with `FORBIDDEN` and nothing is written.
- Socket: a malformed op is nacked with `INVALID_OP` and the server does not crash.
- Socket: resending the same op id returns an ack with the original seq and creates no duplicate row.
- Integration: 100 concurrent op writes produce monotonic gap-free sequences with no duplicates.
- Unit: `applyOp` is idempotent, commutative for disjoint objects, and convergent.
- Unit: a tombstoned object is never resurrected by a later CREATE or UPDATE.
- Unit: partial UPDATE payloads merge field-wise.
- Unit: out-of-order ops buffer and drain contiguously.
- Unit: fractional index generation between two keys sorts correctly.
- E2E **`AT-01`**: A draws, appears in B within 250 ms.
- E2E **`AT-02`**: both draw for 30 s, object counts match exactly.
- E2E **`AT-03`**: A moves X while B recolours X — both changes survive.
- E2E **`AT-04`**: A deletes X while B moves it — gone on both, no zombie.
- E2E **`AT-05`**: both set X's fill within 50 ms — both converge to the later seq.
- E2E **`AT-40`**, **`AT-41`**: now testable — undo does not touch B's work; undo of a deleted object is a no-op.

### Exit gate

Two browser windows sync live and converge. `AT-01` through `AT-05` pass, plus `AT-40` and `AT-41`. Concurrent seq assignment is provably race-free. The board load never flickers. A forged viewer op is rejected server-side.

---

## Phase 10 — Presence: cursors, avatars, remote selection, live strokes

|                |                             |
| -------------- | --------------------------- |
| **Days**       | 28–30                       |
| **Milestone**  | M3                          |
| **Depends on** | Phase 9                     |
| **Owner**      | Renderer owner + Sync owner |

### Objective

The board feels inhabited. Cursors glide, avatars appear, remote selections are visible, and remote strokes draw themselves live rather than popping in complete.

### Requirements

| ID          | Priority | Requirement                                                      |
| ----------- | -------- | ---------------------------------------------------------------- |
| `FR-RT-003` | P0       | Live cursors — 20 Hz, interpolated, fade at 5 s, hide at 15 s    |
| `FR-RT-004` | P0       | Presence list — stacked avatars, max 5 + "+N", 12-colour palette |
| `FR-RT-008` | P0       | Join/leave toasts, 3 s, max 3 stacked                            |
| `FR-RT-005` | P1       | Remote selection indicators                                      |
| `FR-RT-006` | P1       | Live in-progress strokes                                         |
| `FR-RT-011` | P1       | Room capacity — soft limit 50                                    |

### Flows

FLOWS §9.1 (join sequence), §9.2 (cursor rendering rules), §12.5 `E-01`, `E-20`.

### Technical contract

**Ops versus presence** — TRD §5.3. The distinction that governs this entire phase:

|                                   | Ops                     | Presence                                            |
| --------------------------------- | ----------------------- | --------------------------------------------------- |
| Examples                          | create/update/delete    | cursor, selection, in-progress stroke, drag preview |
| Persisted                         | **Yes**, to Postgres    | **Never**                                           |
| Sequence number                   | Yes                     | No                                                  |
| Acknowledged                      | Yes                     | No                                                  |
| Queued in the outbox when offline | Yes                     | **No — dropped**                                    |
| Rate                              | Low                     | High — 20 Hz per user                               |
| Lost message consequence          | Data loss, unacceptable | A cursor stutters, irrelevant                       |

> If you find yourself writing a cursor position to the database, stop. If you find yourself dropping a create-object message because the outbox was full, stop.

**Presence throttling** — TRD §10.3:

```ts
// Cursor: 20 Hz, and only when the position actually changed
const sendCursor = throttle((p: CanvasPoint) => {
  if (p.x === lastSent.x && p.y === lastSent.y) return
  socket.send({ t: 'cursor', x: round1(p.x), y: round1(p.y) })
  lastSent = p
}, 50)

// In-progress stroke: 20 Hz, sending only the DELTA points since the last send
const sendStrokeProgress = throttle((id: string, allPts: number[]) => {
  const delta = allPts.slice(lastSentIndex)
  lastSentIndex = allPts.length
  socket.send({ t: 'stroke', id, pts: delta, done: false })
}, 50)
```

Deltas matter: a 400-point stroke sent in full 20 times per second is roughly **100 KB/s per user**. Deltas reduce that to a few hundred bytes per message (`R-SYNC-041`).

**Cursor interpolation** — TRD §10.4. Raw 50 ms jumps look broken:

```ts
function interpolateCursor(c: RemoteCursor, now: number) {
  const t = Math.min((now - c.updatedAt) / 50, 1)
  return {
    x: c.prevX + (c.x - c.prevX) * t,
    y: c.prevY + (c.y - c.prevY) * t,
  }
}
```

**Cursor rendering rules** — FLOWS §9.2:

| Rule        | Value                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| Send rate   | 20 Hz (every 50 ms), only on actual change                                          |
| Send format | Canvas coordinates, rounded to 1 decimal                                            |
| Receive     | Interpolate over 50 ms, linear easing                                               |
| Layer       | **Overlay layer (3), never the object layer**                                       |
| Idle 5 s    | Fade to 40% opacity                                                                 |
| Idle 15 s   | Hide entirely; the avatar remains in the header                                     |
| Own cursor  | **Never render your own remote cursor.** Obvious, and everyone builds this bug once |

**Presence colours:** the 12-colour palette from PRD §15, assigned round-robin per room at join, chosen to minimize collision. Assigned **server-side** so every participant sees the same colour for the same user (`R-UI-013`).

**Presence in Redis** — TRD §15.2: `HSET presence:{boardId} {sessionId} {json}` plus `EXPIRE`, refreshed on every heartbeat, so a crashed instance's sessions age out rather than becoming permanent ghosts.

**Memory hygiene** — TRD §12.3: delete presence entries on `presence_leave`; sweep entries idle for over 60 s (`R-PERF-023`).

**`E-01`** — two tabs, same user: both work. Each is an independent session with its own socket. Presence shows one avatar (dedupe by user id) but two cursors. Acceptable.

**`E-20`** — long display names: truncate to 20 characters with an ellipsis in the presence pill; full name on hover.

### UI/UX workstream

**Zone:** Board chrome (avatar stack, toasts) and the overlay layer (cursors).

```bash
python3 $S "avatar stack overflow indicator" --domain ux -n 5
python3 $S "toast notification stacking" --domain ux -n 5
```

**Avatar stack** — board header, max 5 visible plus "+N". Hover shows name and role. Each avatar carries its presence colour as a ring.

**Cursor rendering:** a coloured pointer with the display name in a pill beside it. **Colour is never the only indicator** — the name is always present (`R-A11Y-007`).

**Join/leave toasts** — bottom-left on the board so they never cover the properties panel. "Marcus joined" / "Marcus left". Auto-dismiss at 3 s. Maximum 3 stacked; older ones collapse into "+2 more" (`R-UI-055`).

**Remote selection** (`FR-RT-005`): a thin outline in that user's colour with their name label.

### Motion workstream

This phase contains the product's most important motion decision, and it is a subtractive one.

**Cursor interpolation is not decoration — it is data smoothing.** It exists because the wire carries 20 samples per second and the display runs at 60. The 50 ms linear interpolation reconstructs the missing frames. It is exempt from the frequency gate because it is not an animation of a state change; it is the rendering of continuous motion.

**Everything else about presence is instant:**

| Element                  | Animation                                   | Duration | Curve        |
| ------------------------ | ------------------------------------------- | -------- | ------------ |
| Cursor position          | 50 ms linear interpolation (data smoothing) | 50 ms    | `linear`     |
| Cursor idle fade at 5 s  | `opacity` → 0.4                             | 300 ms   | `--ease-out` |
| Cursor hide at 15 s      | `opacity` → 0                               | 300 ms   | `--ease-out` |
| Avatar enters the stack  | `opacity` + `scale(0.9)`→`1`                | 200 ms   | `--ease-out` |
| Avatar leaves            | `opacity` → 0                               | 150 ms   | `--ease-out` |
| Toast enter              | `translateY(100%)`→`0` + `opacity`          | 200 ms   | `--ease-out` |
| Toast exit               | Same direction as entry                     | 150 ms   | `--ease-out` |
| Remote selection outline | **None — instant**                          | —        | —            |
| Remote stroke            | **None — it draws as the points arrive**    | —        | —            |

Toast enter and exit share a direction so swipe-to-dismiss feels intuitive — `emil-design-eng`'s spatial-consistency principle. Exit is faster than entry (`R-MOTION-023`). Percentage translation so the toast height does not matter (`R-MOTION-037`).

**The hard constraint** (`R-CANVAS-002`): all of this renders on layer 3. A cursor moving must never mark layer 1 dirty. Verify by instrumenting `drawObjects` with a counter and confirming it does not increment while a remote cursor moves.

### Tasks

1. `PresenceService`: Redis-backed presence with TTL, refreshed on heartbeat.
2. Server-side colour assignment, round-robin from the 12-colour palette, minimizing in-room collision.
3. `presence_join` / `presence_leave` broadcast; `join_ack` carrying the current user list.
4. Cursor send: 20 Hz throttle, change detection, 1-decimal rounding.
5. Cursor receive: store target and previous with timestamps; interpolate in the render loop.
6. Cursor rendering on the overlay layer with the name pill; own-cursor exclusion.
7. Idle timers: 5 s fade, 15 s hide, with the avatar persisting in the header.
8. Avatar stack with overflow, hover cards, presence-colour rings.
9. Join/leave toasts with stacking and collapse.
10. Remote selection broadcast and outline rendering.
11. Live in-progress remote strokes with delta accumulation and reassembly.
12. Presence cleanup: delete on leave, sweep at 60 s idle.
13. Room capacity soft limit of 50; beyond it new joins are admitted as viewers with a notice.
14. `E-01` two-tab dedupe by user id for avatars, independent cursors.
15. `E-20` name truncation at 20 characters with hover reveal.
16. **Instrument layer 1 draw calls and assert they do not fire on cursor movement.**

### Files

```
apps/server/src/services/PresenceService.ts
apps/server/src/ws/handlers/presence.ts
apps/web/src/features/presence/{usePresence.ts,CursorLayer.ts,AvatarStack.tsx}
apps/web/src/features/presence/interpolate.ts
apps/web/src/features/canvas/renderer/drawOverlay.ts
apps/web/src/components/ui/Toast.tsx
apps/web/src/lib/throttle.ts
```

### Tests

- Unit: cursor throttle emits at most 20/s and skips unchanged positions.
- Unit: interpolation reaches the target exactly at t = 50 ms.
- Unit: stroke delta accumulation reassembles to the full point array.
- Unit: colour assignment avoids collision within a room.
- Socket: `presence_leave` removes the entry; a stale entry is swept after 60 s.
- **Performance: moving a remote cursor does not increment the layer-1 draw counter.** This is the critical test of this phase.
- E2E **`AT-06`**: B joins mid-session and sees the complete board and all live cursors.
- E2E **`AT-07`**: A closes the tab; A's cursor and avatar disappear from B within 5 s.
- E2E **`AT-08`**: 5 users draw simultaneously for 2 minutes; all converge, frame rate holds.

### Exit gate

Cursors glide smoothly at 20 Hz with no stutter. Moving a cursor in one window provably does not redraw the object layer in another. `AT-06`, `AT-07` and `AT-08` pass. Five simultaneous users hold frame rate.

---

## Phase 11 — Reconnection, outbox, gap fill, conflict rules

|                |                  |
| -------------- | ---------------- |
| **Days**       | 31–33            |
| **Milestone**  | M4 — It survives |
| **Depends on** | Phase 10         |
| **Owner**      | Sync owner       |

### Objective

The application survives the network. Users keep working while disconnected, everything they did merges cleanly on reconnect, and nothing is ever lost. This phase makes the zero-loss guarantee real.

The convergence debug harness is built **here**, not in the polish phase. PRD risk `R-1` is explicit about this: build it in week 4.

### Requirements

| ID          | Priority | Requirement                                             |
| ----------- | -------- | ------------------------------------------------------- |
| `FR-RT-009` | P0       | Connection status indicator — exactly five states       |
| `FR-RT-010` | P0       | Offline editing and reconnection with outbox and replay |
| `FR-RT-012` | P0       | Persistence guarantee                                   |

### Flows

FLOWS §9.4 (disconnect and reconnect, the full state flow), §15.2 (connection state machine), §12.5 `E-02`, `E-14`, `E-15`, `E-18`.

### Technical contract

**The connection state machine** — FLOWS §15.2:

```
      ┌──────────────┐
      │ DISCONNECTED │ ◄─────────────────────────┐
      └──────┬───────┘                           │
             │ connect()                         │ close/error
             ▼                                   │ (retries exhausted
      ┌──────────────┐                           │  or offline event)
      │  CONNECTING  │───────fail────────────────┤
      └──────┬───────┘                           │
             │ open + auth ok                    │
             ▼                                   │
      ┌──────────────┐                           │
      │   SYNCING    │  replay missed ops,       │
      │              │  flush the outbox         │
      └──────┬───────┘                           │
             │ outbox empty                      │
             ▼                                   │
      ┌──────────────┐   close/error   ┌──────────────────┐
      │  CONNECTED   │────────────────►│  RECONNECTING    │
      └──────────────┘                 │ (backoff, n≤8)   │
             ▲                         └────────┬─────────┘
             │                                  │ success
             └──────── SYNCING ◄────────────────┘
```

**Every state maps to exactly one header indicator** (`FR-RT-009`). The user always knows which state they are in without opening the console:

| State        | Indicator          | Copy                              |
| ------------ | ------------------ | --------------------------------- |
| Connected    | Green dot, no text | —                                 |
| Connecting   | Amber pulsing dot  | "Connecting…"                     |
| Reconnecting | Amber              | "Reconnecting… (attempt {N})"     |
| Offline      | Red                | "Offline — changes saved locally" |
| Syncing      | Blue               | "Syncing {N} changes…"            |

**The outbox** — TRD §10.1:

```ts
class Outbox {
  private queue: ClientOp[] = []
  private inflight = new Map<string, ClientOp>()
  private readonly STORAGE_KEY = 'coboard.outbox'

  add(op: ClientOp) {
    this.queue.push(op)
    this.persist()
  }

  flush(socket: SocketClient) {
    if (!socket.isOpen) return
    const batch = this.queue.splice(0, 50) // cap the batch size
    for (const op of batch) this.inflight.set(op.id, op)
    socket.send({ t: 'op_batch', ops: batch })
    this.persist()
  }

  onAck(ids: string[]) {
    for (const id of ids) this.inflight.delete(id)
    this.persist()
  }

  onNack(id: string) {
    this.inflight.delete(id) // do NOT retry a nack
    this.persist()
  }

  // On reconnect, anything still in-flight was never acknowledged.
  // Requeue it. Server-side idempotency makes a duplicate send harmless.
  onReconnect() {
    this.queue = [...this.inflight.values(), ...this.queue]
    this.inflight.clear()
  }

  private persist() {
    try {
      localStorage.setItem(
        this.STORAGE_KEY,
        JSON.stringify({
          boardId: this.boardId,
          ops: [...this.inflight.values(), ...this.queue],
        }),
      )
    } catch {
      /* quota or private mode — degrade silently */
    }
  }
}
```

> **Why a nacked op is not retried:** a nack means the server made a decision — forbidden, invalid, rate-limited. Retrying produces the same decision. Retry loops on rejected ops are how you accidentally DDoS your own server. (`R-SYNC-011`, anti-pattern `A-31`)

**Backoff with full jitter** — TRD §10.2:

```ts
private getBackoffDelay(attempt: number): number {
  const base = Math.min(1000 * Math.pow(2, attempt), 30_000)
  return Math.random() * base            // FULL jitter
}
```

> Full jitter — a random value in `[0, base]`, **not** `base ± jitter` — matters: if the server restarts and 50 clients reconnect simultaneously, unjittered backoff makes them all retry in lockstep and hammer the server in synchronized waves. (`R-SYNC-030`, anti-pattern `A-36`)

Triggers that bypass the timer and retry immediately: the `online` event, `visibilitychange` → visible (`E-02` — a backgrounded tab's socket is often silently dead), and the user clicking "Retry now".

**The reconnect flow** — FLOWS §9.4:

```
RECONNECTING
  - Header → amber "Reconnecting… (attempt 1)"
  - Toolbar STAYS ENABLED. The user keeps working
  - Every op goes to the outbox instead of the wire
  - Remote cursors freeze, fade at 5 s, hide at 15 s
  - Presence avatars get a subtle "stale" desaturation
  - Backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s… capped at 30 s, full jitter

  SUCCESS → SYNCING
    - Header → blue "Syncing 12 changes…"
    - send `join` with { sinceSeq: lastAppliedSeq }
    - server returns every op with seq > sinceSeq
    - apply them in seq order
    - flush the outbox in FIFO order, each with its ORIGINAL client-generated
      op id so the server can deduplicate
    - await acks; remove each op from the outbox on ack
    - if an op is REJECTED (e.g. it targets an object deleted while we were
      away): drop it silently, remove its undo entry
    - outbox empty → CONNECTED, header → green
    - Toast: "Back online — 12 changes synced"

  After 8 failed attempts OR navigator.onLine === false → OFFLINE
    - Header → red "Offline — changes saved locally"
    - Persist the outbox to localStorage (survives an accidental refresh)
    - "Retry now" button resets the backoff to attempt 1
    - Listen for the `online` event and retry immediately
    - If the outbox exceeds 500 ops or 10 minutes elapse:
        banner "You've been offline a while. Refresh when you're back
        online to make sure everything is up to date."
```

**The convergence harness** — TRD §6.5. Built now, per PRD risk `R-1`:

A debug panel behind `?debug=1` showing `lastAppliedSeq`, `objects.size`, and a **state hash** — a stable hash of all objects sorted by id, with float coordinates rounded to 2 decimals.

> Two clients on the same board with the same `lastAppliedSeq` must show the same hash. Put this in an automated Playwright test: drive two browser contexts through 200 random operations, then assert that the hashes match. **This one test will catch more real bugs than any other you write on this project.**

### UI/UX workstream

**Zone:** Board chrome.

```bash
python3 $S "offline state connection status" --domain ux -n 5
python3 $S "sync progress indicator" --domain ux -n 5
```

**The connection indicator** is the most important status UI in the product. Colour is never the only signal — every non-connected state carries text (`R-A11Y-007`). Tokens: `--color-success` connected, `--color-warning` reconnecting, `--color-danger` offline, `--color-accent` syncing.

All copy verbatim from PRD §8.2 via `strings.ts`:

- "Offline — your changes are saved locally and will sync when you're back." + "Retry now"
- "Reconnecting… (attempt {N})"
- "Syncing {N} changes…"

**The toolbar stays enabled while disconnected.** Disabling it would be the intuitive choice and it is wrong — the entire point is that the user keeps working.

### Motion workstream

| Element                       | Animation                 | Duration | Curve               |
| ----------------------------- | ------------------------- | -------- | ------------------- |
| Connecting / reconnecting dot | `opacity` pulse loop      | 1.2 s    | `ease-in-out`       |
| Indicator state change        | Colour + width transition | 200 ms   | `--easing-standard` |
| Syncing count                 | Text swap, no animation   | —        | —                   |
| Presence "stale" desaturation | `filter: saturate()`      | 300 ms   | `--ease-out`        |
| Offline banner                | `translateY(-100%)`→`0`   | 200 ms   | `--ease-out`        |

The pulsing dot is the only continuous animation permitted in the board chrome. It communicates "work is happening", which is a valid purpose under `R-MOTION-003`.

Respect `prefers-reduced-motion`: the pulse becomes a static amber dot; the state colour change remains, since colour transitions aid comprehension and are explicitly retained under reduced motion (`R-MOTION-060`).

### Tasks

1. Connection state machine with all six states and guarded transitions.
2. `Outbox` class: queue, inflight, ack/nack handling, `localStorage` persistence, reconnect requeue.
3. **Never-retry-a-nack** enforced and unit-tested.
4. Backoff with full jitter, 8-attempt cap, 30 s ceiling.
5. Immediate-retry triggers: `online`, `visibilitychange`, manual retry.
6. `SYNCING`: rejoin with `sinceSeq`, apply missed ops in order, flush the outbox FIFO with original op ids.
7. Rejected-op handling during sync: drop silently, remove the undo entry.
8. Gap fill: debounced 500 ms `GET /operations?sinceSeq=`.
9. Connection indicator with all five states.
10. Offline banner at 500 ops or 10 minutes.
11. Outbox restoration from `localStorage` on page load.
12. `E-18`: in-memory fallback when `localStorage` is blocked, with no error shown.
13. `E-02`: force a reconnect check on `visibilitychange` → visible.
14. **Convergence debug panel behind `?debug=1`** with `lastAppliedSeq`, object count and state hash.
15. Stable state-hash implementation — sorted by id, floats rounded to 2 dp.
16. **The Playwright convergence harness**: two contexts, 200 seeded random operations, assert matching hashes.
17. Presence stale desaturation during reconnect.

### Files

```
apps/web/src/features/sync/{Outbox.ts,ConnectionMachine.ts,backoff.ts}
apps/web/src/features/sync/SocketClient.ts
apps/web/src/features/sync/stateHash.ts
apps/web/src/components/board/{ConnectionIndicator,OfflineBanner,DebugPanel}.tsx
apps/web/tests/e2e/convergence.spec.ts
apps/web/tests/e2e/helpers/driveRandomOperations.ts
```

### Tests

- Unit: backoff produces values in `[0, min(2^n · 1000, 30000)]`, never a fixed sequence.
- Unit: a nacked op is removed and never re-queued.
- Unit: reconnect moves inflight ops back to the front of the queue.
- Unit: the outbox persists and restores across a simulated reload.
- Unit: the state hash is stable across insertion orders and float noise below 2 dp.
- E2E **`AT-12`**: restart the server mid-session; clients reconnect, no ops lost.
- E2E **`AT-30`**: kill wifi, draw 10 strokes, restore — all 10 appear for everyone, nothing duplicated.
- E2E **`AT-31`**: both A and B offline, both draw, both return — both sets merge, both converge.
- E2E **`AT-32`**: throttle to 3G with 400 ms latency — app usable, local drawing instant.
- E2E **`AT-33`**: kill the connection mid-stroke — the stroke either commits fully or does not exist. **Never a half-stroke.**
- E2E **`AT-34`**: 30 rapid disconnect/reconnect cycles — no duplicate ops, no memory leak, no zombie sockets.
- E2E **`AT-35`**: send a malformed op via the console — the server rejects it, does not crash, other clients unaffected.
- E2E **convergence**: two contexts, 200 random ops, hashes match.
- E2E **offline merge**: 10 strokes each while one is offline, 20 objects on both sides, hashes match.

### Exit gate

All six chaos tests `AT-30`–`AT-35` pass, plus `AT-12`. The convergence harness passes reliably across 10 consecutive runs. The debug panel shows matching hashes on two clients. The zero-loss guarantee holds under every tested failure mode.

---

## Phase 12 — Sharing, share links, guest flow, permission enforcement

|                |                    |
| -------------- | ------------------ |
| **Days**       | 34–36              |
| **Milestone**  | M5 — It's finished |
| **Depends on** | Phase 11           |
| **Owner**      | Product owner      |

### Objective

A stranger clicks a link in Slack and is drawing within 10 seconds without an account. Permissions are enforced server-side on every path. This is Persona B's entire experience and the flow to obsess over.

### Requirements

| ID             | Priority | Requirement                                   |
| -------------- | -------- | --------------------------------------------- |
| `FR-SHARE-001` | P0       | Permission model — exactly four roles         |
| `FR-SHARE-002` | P0       | Share link with ≥128-bit token                |
| `FR-SHARE-005` | P0       | Access denial screen                          |
| `FR-SHARE-006` | P0       | Viewer mode enforced on client **and** server |
| `FR-AUTH-006`  | P0       | Guest identity                                |
| `FR-SHARE-003` | P1       | Revoke and regenerate link                    |
| `FR-SHARE-004` | P1       | Invite by email                               |

### Flows

FLOWS §2.3 (`requireBoardAccess`, the most important guard in the app), §2.4 (cold-load decision tree), §7 (guest joins, all sub-flows), §9.5 (ejection flows), §10 (share modal).

### Technical contract

**The permission model** — `FR-SHARE-001`. Exactly four roles, no others. One Owner per board:

| Role                 | View | Edit objects | Invite | Change settings | Delete board |
| -------------------- | ---- | :----------: | :----: | :-------------: | :----------: |
| **Owner**            | ✅   |      ✅      |   ✅   |       ✅        |      ✅      |
| **Editor**           | ✅   |      ✅      |   ❌   |       ❌        |      ❌      |
| **Commenter** `[P2]` | ✅   |      ❌      |   ❌   |       ❌        |      ❌      |
| **Viewer**           | ✅   |      ❌      |   ❌   |       ❌        |      ❌      |

**Models** — TRD §3.1:

```prisma
model BoardMember {
  id         String   @id @default(uuid())
  boardId    String
  userId     String?                        // null for guests
  guestId    String?                        // client-generated uuid for guests
  guestName  String?  @db.VarChar(40)
  role       Role
  addedById  String?
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())

  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)
  user  User? @relation(fields: [userId],  references: [id], onDelete: Cascade)

  @@unique([boardId, userId])
  @@unique([boardId, guestId])
  @@index([userId])
}

enum Role { OWNER EDITOR VIEWER }

model ShareLink {
  id          String    @id @default(uuid())
  boardId     String
  token       String    @unique            // 32 bytes, base64url
  role        Role                          // EDITOR or VIEWER
  revokedAt   DateTime?
  createdById String
  createdAt   DateTime  @default(now())

  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@index([boardId])
  @@index([token])
}
```

**The permission check that must exist on every path** — TRD §11.2:

```ts
async function assertCanEdit(session: Session) {
  const role = await permissionService.getRole(session.boardId, session.identity)
  if (role !== 'OWNER' && role !== 'EDITOR') {
    throw new ForbiddenError('EDIT_FORBIDDEN')
  }
}
```

Called on every op message, every board mutation endpoint, and the upload presign endpoint. Cached in Redis for 60 s per `(boardId, identity)`, invalidated on any role change.

> **A viewer with the developer console open will try `socket.send({t:'op', …})`.** The client-side disabled toolbar is UX; the server check is security. Test `AT-20` exists precisely to verify this. (`R-SEC-002`)

**`requireBoardAccess`** — FLOWS §2.3. Cold-loading `/board/:boardId` is the single most complex entry point:

```
STEP 1 — Render the board shell immediately.
  Header skeleton, toolbar (disabled), canvas area with a centred spinner.
  Never render a blank white page while resolving access.

STEP 2 — Resolve identity, in priority order:
  a. Access token in memory → authenticated user.
  b. No token → attempt silent refresh.
  c. Refresh fails → check localStorage `coboard.guest` for a guest identity.
  d. No guest identity either → anonymous.

STEP 3 — GET /api/boards/:boardId/access
  Payload includes the guest id (if any) and the share token from
  sessionStorage (if the user arrived via /join/:token).

STEP 4 — Branch:
  200 { role: "owner" | "editor" | "viewer" }        → STEP 5
  200 { role: "none", joinable: true,
        requiresName: true }                          → redirect to /join/:token
  403 { reason: "no_access" }                         → S-17
  403 { reason: "link_revoked" }                      → S-17, "access removed" copy
  404                                                 → S-18
  410 { reason: "deleted" }                           → S-18, "deleted" copy
  5xx / network                                       → inline retry inside the
                                                        canvas area. Do NOT
                                                        navigate away; the URL
                                                        is valid.

STEP 5 — Snapshot + socket IN PARALLEL, with the buffering rule (Phase 9).
STEP 6 — Remove the spinner, enable the toolbar per role, render presence,
  fire the `board_opened` analytics event with the measured load time.
```

**Guest identity** — `FR-AUTH-006`: stored in `localStorage` under `coboard.guest` as `{ id, name, colour }` so returning to the same board reuses the same identity and colour. Guests **cannot** create boards, see a dashboard, change settings, delete the board, or manage members. Guests **can** draw, edit, move and delete objects subject to the link's permission level, and see presence.

**The guest happy path** — FLOWS §7.1. **Target: under 10 seconds from click to first stroke:**

```
1. Clicks coboard.app/join/9fK2…
2. Store the token in sessionStorage. GET /api/share/:token
3. 200 → render the join card
4. Card shows: board name, owner name, "3 people are here now" with live
   avatars, an auto-focused name input, and "Join board"
5. Types "Marcus", presses Enter
   → persist { id: uuid, name, colour } to localStorage.coboard.guest
6. POST /api/share/:token/join { guestId, name } → { boardId, role }
7. navigate('/board/' + boardId, { replace: true })
   ← REPLACE, so Back does not return to the join screen
8. Snapshot + socket in parallel
9. Toast "You're in as Marcus". Existing users see "Marcus joined"
```

**Returning guest** — FLOWS §7.2: if `localStorage.coboard.guest` exists **and** the token is still valid, **skip S-11 entirely**. Show a small dismissible chip: "Joined as Marcus — [Not you?]".

**S-11 failure branches** — FLOWS §7.3:

| Response          | Screen     | Copy                                                                |
| ----------------- | ---------- | ------------------------------------------------------------------- |
| 404 token         | S-17       | "This link isn't valid. Ask whoever shared it for a new one."       |
| 410 revoked       | S-17       | "This link has been turned off."                                    |
| 410 board deleted | S-18       | "This board no longer exists."                                      |
| 403 board full    | S-11 error | "This board is full right now. Try again in a few minutes." + Retry |
| Name empty        | S-11       | "Enter a name so others know who you are."                          |
| Name > 40 chars   | S-11       | Hard-stop at 40, counter shown from 30 onward                       |

**Guest → account conversion** — FLOWS §7.4:

```
Click "Sign up" in the guest bar
  → open S-02 in a NEW TAB (do not destroy their board session)
  → on completion, the new tab posts a message to the opener
  → the board tab silently upgrades: guest identity replaced by the real
    account, the guest is added as an Editor, the presence entry updates
    its name, the bar disappears
  → NOTHING on the canvas is lost
```

Dismissing the bar hides it for that board for 7 days.

**Ejection flows** — FLOWS §9.5:

| Event                    | Client behaviour                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `board:deleted`          | Freeze the canvas, close the socket, full-screen **S-19**. **Do not attempt to sync the outbox — the target is gone** |
| `access:revoked`         | Same treatment, **S-17** copy                                                                                         |
| `role:changed` to viewer | **Do not eject.** Disable the toolbar, cancel any in-progress interaction, toast "You're now a viewer on this board." |
| `board:renamed`          | Header updates live. No toast                                                                                         |
| Server shutdown          | Normal reconnect. Ideally a brief amber flicker and nothing more                                                      |

**Share tokens:** 32 bytes from `crypto.randomBytes`, base64url. Never sequential (`R-SEC-009`).

**Endpoints** — TRD §4.3: members list/add/update/remove/leave, share-link get/create/delete, plus the public `GET /share/:token` and `POST /share/:token/join`.

### UI/UX workstream

**Zones:** Board chrome (S-12 share modal) and Guest (S-11). Guest zone permits `high-end-visual-design` for the join card treatment only (`R-SKILL-040`).

```bash
python3 $S "share modal permission dropdown" --domain ux -n 5
python3 $S "copy to clipboard feedback" --domain ux -n 5
python3 $S "onboarding first impression" --domain ux -n 5
```

**Share modal** — FLOWS §10.1/§10.2. Three sections: invite by email (chips, invalid addresses as red chips blocking Send), people with access (per-member role dropdowns, optimistic with revert), general access (link on/off, edit/view, copy, reset link).

Copy button: label swaps to "Copied!" with a check icon for 2 s. **If the Clipboard API fails**, select the text in a read-only input and show "Press Cmd+C to copy" — a real fallback, not a silent failure.

"Reset link" requires confirmation: "Anyone using the old link will lose access."

**S-11 join card** is the product's first impression for Persona B and the one screen where `high-end-visual-design`'s Double-Bezel treatment is warranted. Name input auto-focused. Live presence avatars showing who is already there — social proof that reduces hesitation.

**S-17 access denied** — FLOWS §12.1. **Never show the board name.** Leaking the name of a board someone cannot access is an information leak (`R-SEC-018`).

**Viewer mode** (`FR-SHARE-006`): the toolbar is replaced with a read-only badge — a Phosphor `Eye` glyph plus "View only", not an emoji (`R-UI-012`).

### Motion workstream

**The guest join is the one place a first-impression flourish is justified.** It happens once per user per board — the "rare" band, where `emil-design-eng` permits delight.

| Element                       | Animation                                             | Duration              | Curve        |
| ----------------------------- | ----------------------------------------------------- | --------------------- | ------------ |
| Join card entry               | `opacity` + `scale(0.96)`→`1` + `translateY(8px)`→`0` | 400 ms                | `--ease-out` |
| Presence avatars on the card  | Stagger in                                            | 200 ms, 60 ms stagger | `--ease-out` |
| "Join board" `:active`        | `scale(0.97)`                                         | 120 ms                | `--ease-out` |
| Board reveal after join       | `opacity` fade-in of the whole shell                  | 250 ms                | `--ease-out` |
| Share modal                   | `opacity` + `translateY(8px)`, origin centre          | 200 ms                | `--ease-out` |
| Copy → "Copied!"              | Content crossfade with `blur(2px)` mask               | 150 ms                | `ease`       |
| Member row role change        | Background flash to `--color-success` at 10% then out | 400 ms                | `--ease-out` |
| S-17 / S-19 full-screen state | `opacity` only, no movement                           | 200 ms                | `--ease-out` |

Ejection states fade without movement. Being removed from a board is already jarring; a bouncy entrance would be tonally wrong.

The 400 ms join-card entry is deliberately at the top of the modal range — it is the one moment where the product introduces itself.

### Tasks

1. `BoardMember` and `ShareLink` models; migration.
2. `PermissionService.getRole` with 60 s Redis caching and invalidation on role change.
3. `assertCanEdit` wired into **every** op message, board mutation endpoint and the upload presign.
4. Share link create/get/revoke with CSPRNG tokens.
5. Public `GET /share/:token` returning board name, owner name and active count.
6. `POST /share/:token/join` creating a guest `BoardMember`.
7. `GET /boards/:id/access` implementing the full STEP 4 branch table.
8. `requireBoardAccess` guard with all six branches and the board shell rendered first.
9. S-11 guest entry with all six failure branches, name validation and the 40-char counter.
10. Guest identity in `localStorage`; returning-guest skip with the "Not you?" chip.
11. `navigate(..., { replace: true })` so Back does not return to the join screen.
12. Guest bar with 7-day dismissal.
13. Guest → account conversion via new tab and `postMessage`, preserving canvas state.
14. S-12 share modal: email chips, member list, role dropdowns, access dropdowns, copy with fallback, reset link.
15. Invite by email: registered users added directly; unregistered receive an invite link and are auto-added on signup.
16. Member role change and removal, emitting `role:changed` and `access:revoked`.
17. Ejection handling for all five events in the table.
18. S-17 and S-18 with correct copy per reason, and no board name on S-17.
19. Viewer mode: toolbar replaced by the badge; all edit paths blocked client-side **and** rejected server-side.
20. Room capacity enforcement with the "board full" response.
21. Analytics: `board_opened`, `board_joined_as_guest`, `share_link_created`, `share_link_copied`.

### Files

```
apps/server/src/services/PermissionService.ts
apps/server/src/http/routes/{members.ts,share.ts}
apps/server/src/ws/handlers/op.ts              # assertCanEdit wiring
apps/web/src/routes/GuestEntry.tsx
apps/web/src/routes/guards.tsx                 # requireBoardAccess
apps/web/src/features/sharing/{ShareModal,MemberRow,ShareLinkSection,useMembers}.tsx
apps/web/src/features/auth/guestIdentity.ts
apps/web/src/components/board/{GuestBar,ViewOnlyBadge}.tsx
apps/web/src/components/states/{AccessDenied,BoardNotFound,BoardDeleted}.tsx
```

### Tests

- Integration: every members and share endpoint, including authorization failures.
- Integration: `GET /access` returns the correct branch for member, guest, open link, no access, deleted, not found.
- Integration: a revoked link immediately fails validation.
- Integration: an Editor calling the delete-board endpoint gets 403 — **`AT-24`**.
- Socket: a viewer's forged op is nacked and nothing is written — **`AT-20`**.
- E2E **`AT-21`**: a non-member opening the board URL sees the access-denied screen with no board name.
- E2E **`AT-22`**: the owner revokes a link while a guest is drawing — ejected within 10 s with the correct message.
- E2E **`AT-23`**: the owner deletes the board with 3 users connected — all 3 see S-19.
- E2E: guest joins via link and draws in under 10 seconds.
- E2E: returning guest skips S-11.
- E2E: guest → account conversion loses nothing on the canvas.
- E2E: `role:changed` to viewer disables the toolbar without ejecting.

### Exit gate

A guest joins via a link and is drawing in under 10 seconds. `AT-20` through `AT-24` pass. A viewer cannot mutate the board even with a forged socket message. Revocation and deletion eject connected users with the correct screens.

---

## Phase 13 — Export, thumbnails, trash, duplicate

|                |               |
| -------------- | ------------- |
| **Days**       | 37–38         |
| **Milestone**  | M5            |
| **Depends on** | Phase 12      |
| **Owner**      | Product owner |

### Objective

Feature completeness. Everything in the P0/P1 set that is not yet built.

### Requirements

| ID              | Priority | Requirement                                            |
| --------------- | -------- | ------------------------------------------------------ |
| `FR-EXPORT-001` | P1       | Export as PNG — whole board, selection or visible area |
| `FR-BOARD-003`  | P1       | Thumbnails (completing Phase 8)                        |
| `FR-BOARD-006`  | P1       | Trash and restore (completing Phase 8)                 |
| `FR-BOARD-007`  | P1       | Duplicate (completing Phase 8)                         |
| `FR-CANVAS-010` | P1       | Image upload                                           |

### Flows

FLOWS §11 (export), §6.8 (trash), §12.5 `E-05`, `E-22`.

### Technical contract

**Export** — FLOWS §11:

```
Export clicked:
  → render to an offscreen canvas at the requested scale
  → if the estimated pixel count exceeds 8192×8192, clamp the scale and
    warn: "Scaled down to fit the maximum export size."
  → toBlob → object URL → programmatic <a download> click
  → filename: {board-name-slugified}-{YYYY-MM-DD}.png
  → revoke the object URL after 60 s
  → close the modal, toast "Exported"
  → for boards over 2,000 objects, show a progress indicator; render in
    chunks with requestAnimationFrame yields so the UI does not freeze
```

Options: scope (whole board / current selection / visible area — selection disabled when nothing is selected), format PNG (SVG is `[P2]`), scale 1× or 2×, transparent background toggle, padding.

**`E-22`** — exporting an empty board: **do not** export a transparent 1×1 file. Block it and toast "There's nothing to export yet."

**Image upload** — `FR-CANVAS-010`, TRD §4.4:

| Method | Path               | Notes                                            |
| ------ | ------------------ | ------------------------------------------------ |
| POST   | `/uploads/presign` | Validates type and size **before** issuing a URL |
| POST   | `/uploads/confirm` | Verifies the object exists; sanitizes SVG        |

> **Do not proxy image bytes through the Node server.** Presigned direct-to-S3 uploads keep the event loop free (decision D-12).

Accepted: PNG, JPEG, GIF, WebP, SVG. Max **10 MB**. The op stores a **URL, never base64**. While uploading, show a placeholder rectangle with a progress ring at the drop position. Failed uploads show an inline error with a retry button.

**`E-05`**: check `File.size` client-side first — do not upload 50 MB and then fail.

**Security:** SVG sanitized server-side with DOMPurify; uploads validated by **magic bytes**, not the client MIME type (`R-SEC-011`, `R-SEC-012`). Rate limit 20 uploads/hour per user.

**Thumbnails** — `FR-BOARD-003`: regenerated client-side when a board session ends or every 5 minutes of active editing, whichever comes first. 640×400 JPEG at 0.7 quality, containing the bounding box of all objects with 5% padding. Empty boards get a **static placeholder graphic**, not a blank white rectangle.

### UI/UX workstream

**Zone:** Board chrome (S-14 export modal) and Product chrome (trash).

```bash
python3 $S "export modal options preview" --domain ux -n 5
python3 $S "file upload drag drop progress" --domain ux -n 5
```

Export modal carries a **live preview thumbnail** that updates as options change — the single most useful affordance in an export dialog.

Trash rows: thumbnail, name, "deleted 3 days ago", "28 days left", Restore, Delete forever. Permanent delete requires typing the exact board name; the confirm button stays disabled until it matches exactly, and the copy must say plainly that it is irreversible.

### Motion workstream

| Element                    | Animation                                    | Duration   | Curve        |
| -------------------------- | -------------------------------------------- | ---------- | ------------ |
| Export modal               | `opacity` + `translateY(8px)`, origin centre | 200 ms     | `--ease-out` |
| Preview update             | Crossfade                                    | 150 ms     | `ease`       |
| Export progress ring       | `stroke-dashoffset`                          | Continuous | `linear`     |
| Upload progress ring       | `stroke-dashoffset`                          | Continuous | `linear`     |
| Image placeholder → loaded | Crossfade                                    | 200 ms     | `--ease-out` |
| Trash row restore          | `opacity` + collapse                         | 200 ms     | `--ease-out` |

Progress indicators use `linear` — a progress bar with easing misrepresents progress.

### Tasks

1. S-14 export modal with scope, format, scale, background and padding controls.
2. Live preview rendering.
3. Offscreen canvas export at the requested scale, with the 8192² clamp and warning.
4. Chunked rendering with rAF yields above 2,000 objects, plus a progress indicator.
5. Blob → object URL → download, filename slugification, 60 s URL revocation.
6. `E-22` empty-board block.
7. `POST /uploads/presign` with type and size validation.
8. `POST /uploads/confirm` with existence check, magic-byte validation and SVG sanitization.
9. Client upload: drag-drop, paste, toolbar button; client-side size check first.
10. Upload placeholder with progress ring; inline error with retry.
11. `ImageObject` rendering with the LRU image cache.
12. Thumbnail generation on session end and every 5 minutes; `PUT /boards/:id/thumbnail`.
13. Empty-board placeholder graphic.
14. Trash view completion with days-remaining and typed-name permanent delete.
15. Duplicate completion.
16. Analytics: `export_completed`.

### Files

```
apps/server/src/http/routes/uploads.ts
apps/server/src/lib/{s3.ts,svgSanitize.ts}
apps/web/src/features/export/{ExportModal,renderToCanvas,download}.tsx
apps/web/src/features/canvas/renderer/shapes/image.ts
apps/web/src/features/canvas/imageCache.ts
apps/web/src/features/uploads/{useUpload.ts,UploadPlaceholder.tsx}
apps/web/src/features/canvas/thumbnail.ts
```

### Tests

- Unit: export bounding box with padding is correct for every scope.
- Unit: the 8192² clamp reduces scale and reports it.
- Unit: filename slugification handles unicode and punctuation.
- Integration: presign rejects oversized files and disallowed types.
- Integration: SVG sanitization strips `<script>`, event handlers and external refs.
- Integration: magic-byte validation rejects a renamed executable.
- Component: export is blocked on an empty board with the correct toast.
- Component: permanent-delete confirm stays disabled until the name matches exactly.
- Manual: export a 5,000-object board without freezing the UI.

### Exit gate

Export produces a correct PNG at both scales for all three scopes. Uploads work end to end with sanitization. Thumbnails appear on dashboard cards. Trash restore and permanent delete work. Every P0/P1 feature now exists.

---

## Phase 14 — Empty states, error states, responsive, accessibility, polish

|                |            |
| -------------- | ---------- |
| **Days**       | 39–42      |
| **Milestone**  | M5         |
| **Depends on** | Phase 13   |
| **Owner**      | Whole team |

### Objective

The largest UI phase. Every state, every breakpoint, every accessibility requirement, every edge case, and a full motion review across the product.

PRD risk `R-4` — _"Interns build the fun canvas parts and skip error/empty states"_ — is rated **Very High** likelihood. This phase is the mitigation, and reviewers reject PRs that skip it.

### Requirements

| ID           | Priority | Requirement                              |
| ------------ | -------- | ---------------------------------------- |
| `FR-SET-003` | P1       | Keyboard shortcuts reference modal (`?`) |
| —            | P1       | PRD §7.5 accessibility                   |
| —            | P1       | PRD §7.7 responsive behaviour            |
| —            | P0/P1    | All 22 edge cases `E-01`–`E-22`          |
| —            | P0       | S-19, S-20, S-21                         |

### Flows

FLOWS §12 (error and edge-case screens, plus the full `E-01`–`E-22` register), §13 (toast, modal and focus conventions), §14.5 (mobile layout).

### Technical contract

**The copy contract.** Every user-facing string from PRD §8.2 and §8.3 lives in `apps/web/src/lib/strings.ts` and nowhere else (`R-UI-052`). Inlining copy at call sites is how two screens end up saying different things about the same condition.

Tone rules (PRD §8.1): second person, present tense; never blame the user; every error says what to do next; no exclamation marks except "Copied!" and celebratory empty states; **never expose internal identifiers, stack traces or error codes** — log them, show a friendly message with a short correlation ID.

**Canonical error strings** — PRD §8.2, verbatim:

| Situation                 | Message                                                                        | Action                                           |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Wrong credentials         | "That email or password didn't match. Try again."                              | —                                                |
| Rate limited (login)      | "Too many attempts. Try again in {N} minutes."                                 | —                                                |
| Email already registered  | "An account already exists for this email."                                    | "Log in instead"                                 |
| Weak password             | "Password needs at least 8 characters, including a letter and a number."       | —                                                |
| No board access           | "You don't have access to this board."                                         | "Ask the owner for access" / "Back to dashboard" |
| Board not found           | "This board doesn't exist, or it was deleted."                                 | "Back to dashboard"                              |
| Board deleted while open  | "The owner deleted this board."                                                | "Back to dashboard"                              |
| Access revoked while open | "Your access to this board was removed."                                       | "Back to dashboard"                              |
| Disconnected              | "Offline — your changes are saved locally and will sync when you're back."     | "Retry now"                                      |
| Reconnecting              | "Reconnecting… (attempt {N})"                                                  | —                                                |
| Syncing                   | "Syncing {N} changes…"                                                         | —                                                |
| Op rejected               | "That change couldn't be saved."                                               | "Undo"                                           |
| Upload too large          | "Images must be under 10 MB."                                                  | —                                                |
| Unsupported file          | "We support PNG, JPG, GIF, WebP, and SVG."                                     | —                                                |
| Upload failed             | "Upload failed."                                                               | "Retry" / "Remove"                               |
| Board too large           | "This board is getting large. Consider splitting it up."                       | "Dismiss"                                        |
| Generic server error      | "Something went wrong on our end. We're looking into it." + `Ref: {8-char id}` | "Retry"                                          |
| Unsupported browser       | "CoBoard needs a modern browser. Try Chrome, Firefox, Edge, or Safari."        | —                                                |

**Empty states** — PRD §8.3:

| Screen                  | Headline                                                                                                                                               | Body                                            | CTA            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | -------------- |
| Dashboard, no boards    | "Nothing here yet"                                                                                                                                     | "Create your first board and invite your team." | "New board"    |
| Dashboard, filter empty | "No boards match that filter"                                                                                                                          | —                                               | "Clear filter" |
| Trash empty             | "Trash is empty"                                                                                                                                       | "Deleted boards appear here for 30 days."       | —              |
| Board with no objects   | Faint centred hint: "Pick a tool and start drawing" with an arrow pointing at the toolbar. **Fades out permanently after the first object is created** | —                                               | —              |
| Search no results       | "No boards found for '{query}'"                                                                                                                        | —                                               | "Clear search" |

**The full edge-case register** — FLOWS §12.5. All 22 are requirements, not suggestions:

| #      | Situation                         | Behaviour                                                                                    |
| ------ | --------------------------------- | -------------------------------------------------------------------------------------------- |
| `E-01` | Two tabs, same user               | Both work. One avatar (dedupe by user id), two cursors                                       |
| `E-02` | Tab backgrounded 30 min           | On `visibilitychange` → visible, force a reconnect check immediately                         |
| `E-03` | User's clock is wrong             | Never trust client timestamps. Server seq is the only ordering authority                     |
| `E-04` | Extreme coordinates               | Clamp to ±1,000,000 on creation; reject out-of-range server-side                             |
| `E-05` | 50 MB image pasted                | Reject before upload. Check `File.size` client-side first                                    |
| `E-06` | Non-image clipboard data          | Plain text → create a text object. Otherwise ignore silently                                 |
| `E-07` | Dragging 500 objects              | Batch into one op message. Throttle presence to 10 Hz above 100 selected                     |
| `E-08` | Tool switch during a drag         | Ignore tool changes while an interaction is in progress                                      |
| `E-09` | `Escape` during a stroke          | Cancel entirely. Nothing committed, nothing broadcast                                        |
| `E-10` | Window resized mid-drag           | Recompute backing store, preserve viewport centre, keep the drag alive                       |
| `E-11` | 2 px object at 500% zoom          | Still hit-testable; handles keep an 8 px minimum touch target                                |
| `E-12` | 5,000 objects at 10% zoom         | Cull off-screen; below 25% render strokes as simplified paths                                |
| `E-13` | Op for an unknown object id       | Log, ignore; request a fresh snapshot after 3 in a minute                                    |
| `E-14` | `seq <= lastAppliedSeq`           | Ignore — duplicate                                                                           |
| `E-15` | `seq > lastAppliedSeq + 1`        | Buffer, request the missing range, never apply out of order                                  |
| `E-16` | Double-click "New board"          | Button disables on first click. One board                                                    |
| `E-17` | Session expires with a board open | Keep the socket alive, refresh silently; on failure show a banner. **Never lose their work** |
| `E-18` | `localStorage` blocked            | Fall back to in-memory. App works; preferences do not persist. **Show no error**             |
| `E-19` | Simultaneous board rename         | Last write wins. Both see the final name                                                     |
| `E-20` | Very long display name            | Truncate to 20 chars with ellipsis; full name on hover                                       |
| `E-21` | Slow 3G board load                | 30 s snapshot timeout, then an inline retry. **Never leave a spinner forever**               |
| `E-22` | Export an empty board             | Block it: "There's nothing to export yet."                                                   |

**Toast conventions** — FLOWS §13.1: bottom-left on the board (never covering the properties panel), bottom-centre elsewhere. Max 3 visible, older collapse to "+2 more". Info/success 3 s, error 6 s, error-with-action 8 s. **Never use a toast for anything requiring a decision — that is a modal.** `aria-live="polite"` for info/success, `"assertive"` for errors.

**Modal conventions** — FLOWS §13.2: focus trap; initial focus on the first interactive element or the primary action for confirmations; focus **always** returns to the trigger; `Escape` closes unless a destructive action is mid-flight; backdrop click closes non-destructive modals only; body scroll locked; at most one modal at a time.

**Board focus and keyboard** — FLOWS §13.3: the canvas is focusable (`tabIndex=0`). Tab order: header → toolbar → canvas → properties panel → zoom controls. **Every shortcut is suppressed while a text input, the on-canvas text overlay, or a modal has focus — except `Escape`** and `Cmd/Ctrl+Enter`.

**Responsive** — PRD §7.7:

| Breakpoint   | Behaviour                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| ≥ 1280 px    | Full layout: left toolbar, right properties panel, header                                                               |
| 1024–1279 px | Properties panel collapses to a popover triggered by selection                                                          |
| 768–1023 px  | Toolbar becomes a bottom bar; dashboard grid drops to 2 columns                                                         |
| < 768 px     | Mobile: bottom toolbar with 5 core tools, pinch/pan, no properties panel, no marquee. Dashboard is a single-column list |

**Mobile specifics** — FLOWS §14.5: 5 primary tools with `⋯` opening a sheet for the rest; properties as a bottom sheet on selection; one-finger drag pans, tap to select, long-press to multi-select; 44 px touch targets; share modal becomes a full-screen sheet; text editing scrolls the canvas so the edited object sits above the keyboard.

**Accessibility** — PRD §7.5. The canvas itself cannot be made fully accessible with reasonable effort and we accept that. **Everything around it must be.** All non-canvas UI keyboard navigable with a visible focus ring; accessible names on all controls; contrast ≥4.5:1 text and ≥3:1 boundaries; modals trap focus and restore it; toasts announced via `aria-live`; the canvas has `role="img"` with a summary like "Whiteboard with 24 objects"; **never convey information by colour alone** — presence colours are always paired with a name; respect `prefers-reduced-motion`.

**Browser support** — PRD §7.6: Chrome/Edge last 2, Firefox last 2, Safari 16+, iOS Safari 16+ and Chrome Android touch-adapted. **Internet Explorer is not supported** — show the unsupported-browser screen.

### UI/UX workstream

**Zones:** all of them. This is the phase where the zoning map gets exercised end to end.

```bash
python3 $S "empty state illustration copy" --domain ux -n 5
python3 $S "error boundary recovery" --domain ux -n 5
python3 $S "responsive breakpoint mobile" --domain ux -n 5
python3 $S "aria live region announcement" --domain web -n 5
python3 $S "focus trap modal" --domain web -n 5
```

Run the `ui-ux-pro-max` pre-delivery checklist (`R-UI-040`) against **every** screen, not a sample.

**S-21 error boundary** — FLOWS §12.4: wraps the whole app, and **separately wraps the canvas subtree** so a canvas crash does not take the header and navigation down with it. Log the full error, component stack, board id, user id and correlation ID to the error service; show the user only the correlation ID.

**S-19** renders as a full-screen overlay **on top of the frozen canvas**, so the user has visual continuity and understands what just happened.

### Motion workstream

This phase includes a **full `emil-design-eng` review pass across every animated component in the product** (`R-SKILL-072`). Output the Before/After/Why table and act on it.

Checklist for the pass:

- [ ] No `transition: all` anywhere
- [ ] No `ease-in` on any UI element
- [ ] No animation from `scale(0)`
- [ ] No UI animation over 300 ms except modals and the join card
- [ ] Every popover and tooltip is origin-aware; modals are centre-origin
- [ ] No keyframes on rapidly-triggered elements
- [ ] Exit is faster than entry everywhere
- [ ] Stagger delays 30–80 ms, capped in count
- [ ] Every hover animation gated behind `@media (hover: hover) and (pointer: fine)`
- [ ] `prefers-reduced-motion` verified on every screen
- [ ] Only `transform` and `opacity` animate
- [ ] No `backdrop-blur` on any scrolling container
- [ ] **No animation anywhere on the four canvas layers**
- [ ] No Framer Motion import reachable from the board route

Review the animations the next day with fresh eyes, and in slow motion at 3–5× duration (`R-MOTION-071`).

### Tasks

1. Populate `strings.ts` with every string from PRD §8.2 and §8.3. Replace every inlined string.
2. All five empty states, including the board's fade-out-permanently first-object hint.
3. S-19, S-20, S-21 with correct copy and actions.
4. Error boundary wrapping the app, and a second one wrapping the canvas subtree.
5. Correlation ID generation, display and error-service logging.
6. Work through all 22 edge cases `E-01`–`E-22` as an explicit checklist. Several are already done in earlier phases — verify each rather than assuming.
7. Toast system completion: positioning per context, stacking, collapse, durations, `aria-live`.
8. Modal system completion: focus trap, initial focus, focus restore, `Escape`, backdrop rules, scroll lock, single-modal enforcement.
9. Board focus management and full tab order.
10. Shortcut suppression while text inputs, the text overlay or modals have focus.
11. S-15 shortcuts modal (`?`) listing every shortcut from PRD Appendix A.
12. All four breakpoints: properties popover at 1024–1279, bottom toolbar at 768–1023, full mobile below 768.
13. Mobile layout: 5-tool bottom bar with overflow sheet, bottom-sheet properties, touch gestures, 44 px targets, full-screen share sheet, keyboard-aware text editing.
14. Accessibility pass: focus rings, `aria-label` on every icon-only button, contrast verification, canvas `role="img"` with a live object-count summary.
15. `prefers-reduced-motion` verified across every screen.
16. Unsupported-browser screen.
17. The `emil-design-eng` motion review pass and its fixes.
18. Analytics event wiring for all 14 events in PRD §9.

### Files

```
apps/web/src/lib/strings.ts                    # every user-facing string
apps/web/src/components/states/*.tsx           # all empty and error states
apps/web/src/components/ui/{Toast,Modal,FocusTrap}.tsx
apps/web/src/components/board/ShortcutsModal.tsx
apps/web/src/ErrorBoundary.tsx
apps/web/src/features/canvas/CanvasErrorBoundary.tsx
apps/web/src/hooks/{useBreakpoint,useReducedMotion,useFocusTrap}.ts
apps/web/src/components/mobile/{BottomToolbar,ToolSheet,PropertiesSheet}.tsx
apps/web/src/lib/analytics.ts
```

### Tests

- Component: every empty state renders with exact PRD copy.
- Component: every error state renders with exact PRD copy and the right actions.
- Component: modal focus trap, initial focus and focus restore.
- Component: toast stacking, collapse at 4+, and correct `aria-live` values.
- Unit: shortcuts are suppressed when a text input has focus, except `Escape`.
- E2E: all 22 edge cases, one test each.
- E2E: full keyboard-only pass through every non-canvas screen.
- E2E: every breakpoint renders without horizontal scroll.
- Automated: axe accessibility scan on every route, zero violations.
- Manual: screen-reader pass on auth, dashboard and board chrome.
- Manual: `prefers-reduced-motion` on every screen.

### Exit gate

Every P0 and P1 requirement has a passing test. All 22 edge cases verified. Zero axe violations. Full keyboard-only navigation works. Every breakpoint renders correctly. The motion review pass is complete and its findings fixed. Copy matches PRD §8 exactly, everywhere.

---

## Phase 15 — Performance pass, e2e suite, deployment, monitoring

|                |            |
| -------------- | ---------- |
| **Days**       | 43–45      |
| **Milestone**  | M5         |
| **Depends on** | Phase 14   |
| **Owner**      | Whole team |

### Objective

Every budget met and enforced, the full e2e suite green, deployed, and monitored.

### Requirements

All of PRD §7.1 (performance budgets), §7.2 (scalability), §7.3 (reliability).

### Technical contract

**The budgets** — PRD §7.1. A PR that regresses one does not merge:

| Metric                              | Budget                          | Measured how              |
| ----------------------------------- | ------------------------------- | ------------------------- |
| Landing page LCP                    | ≤ 1.5 s on 4G                   | Lighthouse                |
| Dashboard interactive               | ≤ 2.0 s                         | Lighthouse                |
| Board first paint (500 objects)     | ≤ 1.5 s                         | Custom perf mark          |
| Board first paint (5,000 objects)   | ≤ 3.0 s                         | Custom perf mark          |
| Drawing frame rate                  | ≥ 55 fps with 5,000 objects     | Chrome perf panel         |
| Pan/zoom frame rate                 | ≥ 55 fps                        | Chrome perf panel         |
| Input-to-local-pixel latency        | ≤ 16 ms                         | Manual + instrumented     |
| Local-input-to-remote-render p95    | ≤ 250 ms                        | Instrumented, same-region |
| Cursor update rate                  | 20 Hz send, interpolated render | Code review               |
| Initial JS bundle (gzipped)         | ≤ 250 KB                        | Bundle analyzer, CI gate  |
| Board route chunk (gzipped)         | ≤ 200 KB                        | Bundle analyzer           |
| Memory with 5,000 objects           | ≤ 300 MB heap                   | Chrome memory profiler    |
| WebSocket message size (typical op) | ≤ 2 KB                          | Network tab               |

**Scalability targets** — PRD §7.2: 1,000 registered users · 50 concurrent per board · 200 concurrent boards · 50,000 objects max per board with a soft warning at 10,000 · 100 ops/second sustained per board.

**Bundle splitting** — TRD §12.2. The landing and auth routes must not pull in the canvas engine:

```ts
const Board = lazy(() => import('./routes/Board'))
const Dashboard = lazy(() => import('./routes/Dashboard'))
const Settings = lazy(() => import('./routes/Settings'))
```

**Memory leak prevention** — TRD §12.3:

| Leak source             | Prevention                                                |
| ----------------------- | --------------------------------------------------------- |
| Socket listeners        | Every `addEventListener` has a matching remove in cleanup |
| `requestAnimationFrame` | `cancelAnimationFrame` on unmount                         |
| Image cache             | Cap at 100 entries with LRU eviction                      |
| Presence maps           | Delete on `presence_leave`; sweep entries idle over 60 s  |
| Tombstones              | Cleared on board unload; capped at 10,000 FIFO            |
| Undo history            | Hard cap at 100                                           |
| Detached canvases       | Null the refs on unmount                                  |

Test: open a board, use it for 30 minutes, heap snapshot, close and reopen 10 times, force GC, snapshot again. **Growth should be near zero.**

**Deployment topology** — TRD §15.1: Cloudflare for TLS and DDoS; static host for the SPA; load balancer with sticky sessions via `ip_hash` for WebSocket; Node instances; Postgres with a replica; Redis for pub/sub and presence; S3.

**Multi-instance** — TRD §15.2: Redis pub/sub bridges instances. Presence lives in Redis with TTLs so a crashed instance's sessions age out. **For v1 a single instance is acceptable**, but the pub/sub path is written so scaling is configuration, not a rewrite. Sticky sessions reduce cross-instance chatter but must not be a correctness requirement.

**Monitoring** — TRD §15.4:

| Signal                            | Alert threshold             |
| --------------------------------- | --------------------------- |
| Error rate                        | > 1% of requests over 5 min |
| Op persist latency p95            | > 100 ms                    |
| WebSocket connection failure rate | > 5%                        |
| Connected sockets                 | Sudden drop > 50%           |
| Postgres pool utilization         | > 80%                       |
| Redis memory                      | > 80%                       |
| Client `op_rejected` rate         | > 0.1% of ops               |
| Snapshot job failures             | Any                         |

Log every op rejection with code, board, actor and correlation ID. A spike in rejections is the earliest signal that something is wrong with permissions or validation.

**Reliability** — PRD §7.3: target uptime 99.5%. **Zero committed-op loss** — stricter than uptime: the system may be briefly unavailable but must never lose an acknowledged operation. Automated daily backups with a **tested** restore procedure.

### UI/UX workstream

No new UI. Verify the pre-delivery checklist one final time on the deployed build, on real devices rather than a desktop emulator.

### Motion workstream

Final verification on real hardware, including a mid-range Android device. Confirm no animation drops frames while the board is under load, and that `prefers-reduced-motion` is honoured on the deployed build.

### Tasks

1. Profile the board with 5,000 and 10,000 objects; address anything outside the frame-cost distribution in TRD §12.1.
2. Style batching verification — sort visible objects by style, set context properties only on change.
3. Route-level code splitting; confirm the landing and auth chunks exclude the canvas engine.
4. Bundle analysis; bring both chunks under budget.
5. Verify the board-route animation-library import check still passes.
6. The 30-minute memory test with before/after heap snapshots.
7. Fix every leak the test reveals.
8. Complete the Playwright suite: every scenario in PRD §11 (`AT-01`–`AT-44`).
9. Verify the five must-write tests from TRD §13.2 all pass.
10. Lighthouse CI on landing and dashboard.
11. Instrument and verify p95 local-input-to-remote-render.
12. Load test: 50 concurrent users on one board, 100 ops/second sustained.
13. Deployment: static host, Node instances, load balancer with sticky sessions, Cloudflare.
14. Database backups with a **tested restore**.
15. Monitoring dashboards and alerts for all eight signals.
16. Structured logging with correlation IDs end to end.
17. Run the 10-point manual QA checklist (TRD §13.3).
18. Cross-browser verification: Safari, Firefox, Chrome — strokes must look identical.

### Files

```
.github/workflows/{ci.yml,deploy.yml}
apps/web/vite.config.ts                # chunking configuration
apps/server/src/lib/logger.ts
apps/server/src/metrics.ts
infra/                                 # deployment configuration
docs/RUNBOOK.md                        # restore procedure, alert response
```

### Tests

- Every budget in PRD §7.1 measured and met.
- Full Playwright suite green, including all 28 `AT-*` scenarios.
- Memory growth near zero across the 30-minute test.
- Load test sustains 50 users and 100 ops/second per board.
- Restore from backup verified on a scratch database.
- Cross-browser stroke rendering identical.

### Exit gate

Every performance budget met and CI-enforced. Every `AT-*` scenario passes. Deployed and monitored. Backup restore tested. Every P0 and P1 requirement has a passing test and a reviewed PR.

---

# 8. Reference appendices

---

## Appendix A — Requirement traceability matrix

Every one of the 63 defined requirements, its priority, and the phase that delivers it. **36 P0 · 19 P1 · 8 P2.** All 55 P0/P1 requirements are assigned to a delivering phase.

> **Note on the P1/P2 split.** Counting the priority labels in the PRD headings directly gives 36 / **20** / **7**. The difference is `FR-CANVAS-017`, whose heading reads `[P1]` while its title and body read `[P2]` and "Deferred. Do not build." Per defect **`D-2`** (`RULES.md` §2.4) the body wins, so it is counted as P2 here. The totals below use the post-`D-2` classification throughout.

### Authentication and identity

| ID            | Pri | Requirement                                     | Phase |
| ------------- | --- | ----------------------------------------------- | ----- |
| `FR-AUTH-001` | P0  | Email + password registration                   | 7     |
| `FR-AUTH-002` | P0  | Email + password login, generic errors, lockout | 7     |
| `FR-AUTH-003` | P1  | Google OAuth sign-in with account linking       | 7     |
| `FR-AUTH-004` | P1  | Password reset, single-use 60 min token         | 7     |
| `FR-AUTH-005` | P0  | Session persistence, 30 days, silent refresh    | 7     |
| `FR-AUTH-006` | P0  | Guest identity                                  | 12    |
| `FR-AUTH-007` | P1  | Logout                                          | 7     |

### Board management

| ID             | Pri | Requirement                    | Phase                 |
| -------------- | --- | ------------------------------ | --------------------- |
| `FR-BOARD-001` | P0  | Create board, no naming dialog | 8                     |
| `FR-BOARD-002` | P0  | Board list / dashboard         | 8                     |
| `FR-BOARD-003` | P1  | Board thumbnails               | 8 → 13                |
| `FR-BOARD-004` | P0  | Rename board                   | 8                     |
| `FR-BOARD-005` | P0  | Delete board (soft)            | 8                     |
| `FR-BOARD-006` | P1  | Trash and restore              | 8 → 13                |
| `FR-BOARD-007` | P1  | Duplicate board                | 8 → 13                |
| `FR-BOARD-008` | P2  | Star / favourite               | **Deferred** — App. N |
| `FR-BOARD-009` | P2  | Templates                      | **Deferred** — App. N |

### Sharing and permissions

| ID             | Pri | Requirement                                    | Phase |
| -------------- | --- | ---------------------------------------------- | ----- |
| `FR-SHARE-001` | P0  | Permission model, four roles                   | 12    |
| `FR-SHARE-002` | P0  | Share link, ≥128-bit token                     | 12    |
| `FR-SHARE-003` | P1  | Revoke and regenerate link                     | 12    |
| `FR-SHARE-004` | P1  | Invite by email                                | 12    |
| `FR-SHARE-005` | P0  | Access denial screen                           | 12    |
| `FR-SHARE-006` | P0  | Viewer mode enforcement, client **and** server | 12    |

### Canvas — objects and tools

| ID              | Pri | Requirement                       | Phase                 |
| --------------- | --- | --------------------------------- | --------------------- |
| `FR-CANVAS-001` | P0  | Infinite canvas, ±1,000,000 clamp | 2                     |
| `FR-CANVAS-002` | P0  | Pan                               | 2                     |
| `FR-CANVAS-003` | P0  | Zoom, 10–500%, pointer-anchored   | 2                     |
| `FR-CANVAS-004` | P0  | Select tool                       | 4                     |
| `FR-CANVAS-005` | P0  | Pen / freehand tool               | 3                     |
| `FR-CANVAS-006` | P0  | Eraser tool                       | 4                     |
| `FR-CANVAS-007` | P0  | Shape tools                       | 5                     |
| `FR-CANVAS-008` | P0  | Sticky note tool                  | 5                     |
| `FR-CANVAS-009` | P0  | Text tool                         | 5                     |
| `FR-CANVAS-010` | P1  | Image upload                      | 13                    |
| `FR-CANVAS-011` | P0  | Move objects                      | 4                     |
| `FR-CANVAS-012` | P0  | Resize objects                    | 4                     |
| `FR-CANVAS-013` | P1  | Rotate objects                    | 4                     |
| `FR-CANVAS-014` | P0  | Delete objects                    | 4                     |
| `FR-CANVAS-015` | P0  | Copy / cut / paste / duplicate    | 5                     |
| `FR-CANVAS-016` | P1  | Z-order, fractional index         | 9                     |
| `FR-CANVAS-017` | P2  | Grouping — see defect `D-2`       | **Deferred** — App. N |
| `FR-CANVAS-018` | P0  | Undo / redo                       | 6                     |
| `FR-CANVAS-019` | P1  | Context menu                      | 5                     |
| `FR-CANVAS-020` | P1  | Alignment guides                  | 5                     |
| `FR-CANVAS-021` | P2  | Grid and snap-to-grid             | **Deferred** — App. N |
| `FR-CANVAS-022` | P0  | Select all / deselect             | 4                     |

### Real-time collaboration

| ID          | Pri | Requirement                      | Phase |
| ----------- | --- | -------------------------------- | ----- |
| `FR-RT-001` | P0  | Live object sync, p95 250 ms     | 9     |
| `FR-RT-002` | P0  | Optimistic local application     | 9     |
| `FR-RT-003` | P0  | Live cursors                     | 10    |
| `FR-RT-004` | P0  | Presence list                    | 10    |
| `FR-RT-005` | P1  | Remote selection indicators      | 10    |
| `FR-RT-006` | P1  | Live in-progress strokes         | 10    |
| `FR-RT-007` | P0  | Concurrent edit resolution       | 9     |
| `FR-RT-008` | P0  | Join / leave notifications       | 10    |
| `FR-RT-009` | P0  | Connection status indicator      | 11    |
| `FR-RT-010` | P0  | Offline editing and reconnection | 11    |
| `FR-RT-011` | P1  | Room capacity                    | 10    |
| `FR-RT-012` | P0  | Persistence guarantee            | 9     |

### Comments, export, settings

| ID               | Pri | Requirement                  | Phase                 |
| ---------------- | --- | ---------------------------- | --------------------- |
| `FR-COMMENT-001` | P2  | Comment threads              | **Deferred** — App. N |
| `FR-EXPORT-001`  | P1  | Export as PNG                | 13                    |
| `FR-EXPORT-002`  | P2  | Export as SVG                | **Deferred** — App. N |
| `FR-EXPORT-003`  | P2  | Export board JSON            | **Deferred** — App. N |
| `FR-SET-001`     | P1  | Profile settings             | 7                     |
| `FR-SET-002`     | P2  | Appearance / theme           | **Deferred** — App. N |
| `FR-SET-003`     | P1  | Keyboard shortcuts reference | 14                    |

### Coverage by phase

| Phase     | P0     | P1     | Total  |
| --------- | ------ | ------ | ------ |
| 2         | 3      | 0      | 3      |
| 3         | 1      | 0      | 1      |
| 4         | 6      | 1      | 7      |
| 5         | 4      | 2      | 6      |
| 6         | 1      | 0      | 1      |
| 7         | 3      | 4      | 7      |
| 8         | 4      | 3      | 7      |
| 9         | 4      | 1      | 5      |
| 10        | 3      | 3      | 6      |
| 11        | 2      | 0      | 2      |
| 12        | 5      | 2      | 7      |
| 13        | 0      | 2      | 2      |
| 14        | 0      | 1      | 1      |
| **Total** | **36** | **19** | **55** |

`FR-BOARD-003`, `-006` and `-007` span two phases (begin in 8, complete in 13). They are counted once, at Phase 8, in the totals above.

### Dangling references — not requirements

| Reference      | Status                                                                          |
| -------------- | ------------------------------------------------------------------------------- |
| `FR-BOARD-041` | **Does not exist.** Defect `D-1`. The behaviour is `E-17`, delivered in Phase 7 |
| `FR-BOARD-012` | Illustrative example in PRD §0, not a requirement. Defect `D-3`                 |

---

## Appendix B — Screens: zone and phase

All 22 screens. Each appears exactly once, with both a zone (`RULES.md` §4.2) and a delivering phase.

| #    | Screen                  | Route                         | Auth        | Pri | Zone                  | Phase        |
| ---- | ----------------------- | ----------------------------- | ----------- | --- | --------------------- | ------------ |
| S-01 | Landing page            | `/`                           | No          | P1  | Marketing             | 14           |
| S-02 | Sign up                 | `/signup`                     | No          | P0  | Auth                  | 7            |
| S-03 | Log in                  | `/login`                      | No          | P0  | Auth                  | 7            |
| S-04 | Forgot password         | `/forgot-password`            | No          | P1  | Auth                  | 7            |
| S-05 | Reset password          | `/reset-password?token=`      | No          | P1  | Auth                  | 7            |
| S-06 | OAuth callback          | `/auth/callback`              | No          | P1  | Auth                  | 7            |
| S-07 | Dashboard               | `/dashboard`                  | Yes         | P0  | Product chrome        | 8            |
| S-08 | Trash                   | `/dashboard/trash`            | Yes         | P1  | Product chrome        | 8 → 13       |
| S-09 | Template picker         | `/dashboard` + modal          | Yes         | P2  | Product chrome        | **Deferred** |
| S-10 | **Board canvas**        | `/board/:boardId`             | Conditional | P0  | Board chrome + Canvas | 2–6, 9–11    |
| S-11 | Guest name entry        | `/join/:token`                | No          | P0  | Guest                 | 12           |
| S-12 | Share modal             | `/board/:boardId` + modal     | Yes         | P0  | Board chrome          | 12           |
| S-13 | Board settings modal    | `/board/:boardId` + modal     | Owner       | P1  | Board chrome          | 12           |
| S-14 | Export modal            | `/board/:boardId` + modal     | Conditional | P1  | Board chrome          | 13           |
| S-15 | Shortcuts modal         | any + modal                   | No          | P1  | Board chrome          | 14           |
| S-16 | Profile settings        | `/settings`                   | Yes         | P1  | Product chrome        | 7            |
| S-17 | Access denied           | `/board/:boardId` 403         | —           | P0  | System states         | 12           |
| S-18 | Board not found         | `/board/:boardId` 404         | —           | P0  | System states         | 12           |
| S-19 | Board deleted (ejected) | in-board full-screen          | —           | P0  | System states         | 12           |
| S-20 | Generic 404             | `*`                           | No          | P1  | System states         | 14           |
| S-21 | Error boundary          | any                           | —           | P0  | System states         | 14           |
| S-22 | Onboarding tour overlay | `/board/:boardId` first visit | —           | P2  | Guest                 | **Deferred** |

### Route guards

| Route                                       | Guard                | Redirect on failure  |
| ------------------------------------------- | -------------------- | -------------------- |
| `/` `/login` `/signup` `/forgot-password`   | `redirectIfAuthed`   | `/dashboard`         |
| `/reset-password`                           | requires `?token=`   | `/forgot-password`   |
| `/auth/callback`                            | requires `?code=`    | `/login?error=oauth` |
| `/dashboard` `/dashboard/trash` `/settings` | `requireAuth`        | `/login?next=…`      |
| `/board/:boardId`                           | `requireBoardAccess` | See Phase 12 STEP 4  |
| `/join/:token`                              | none                 | —                    |
| `*`                                         | none                 | —                    |

---

## Appendix C — REST API contract

Base `/api`. All responses JSON. Errors use a single shape:

```jsonc
{
  "error": {
    "code": "BOARD_NOT_FOUND", // stable machine-readable code
    "message": "Board not found", // developer-facing, never shown raw
    "details": {}, // optional field-level errors
    "correlationId": "8f3a2b91", // matches the server log entry
  },
}
```

### Auth

| Method | Path                    | Body                             | Success                              | Errors                                           |
| ------ | ----------------------- | -------------------------------- | ------------------------------------ | ------------------------------------------------ |
| POST   | `/auth/register`        | `{email, password, displayName}` | 201 `{user, accessToken}` + cookie   | 409 `EMAIL_TAKEN`, 422, 429                      |
| POST   | `/auth/login`           | `{email, password}`              | 200 `{user, accessToken}` + cookie   | 401 `INVALID_CREDENTIALS`, 429                   |
| POST   | `/auth/refresh`         | — (cookie)                       | 200 `{accessToken}` + rotated cookie | 401 `INVALID_REFRESH`                            |
| POST   | `/auth/logout`          | —                                | 204                                  | —                                                |
| GET    | `/auth/me`              | —                                | 200 `{user}`                         | 401                                              |
| GET    | `/auth/google`          | —                                | 302 to Google                        | —                                                |
| GET    | `/auth/google/callback` | `?code`                          | 302 to client                        | 302 `?error=`                                    |
| POST   | `/auth/forgot-password` | `{email}`                        | 200 always                           | 429                                              |
| GET    | `/auth/reset/validate`  | `?token`                         | 200 `{valid:true}`                   | 400 `TOKEN_INVALID`/`TOKEN_EXPIRED`/`TOKEN_USED` |
| POST   | `/auth/reset`           | `{token, password}`              | 200                                  | 400, 422                                         |

### Boards

| Method | Path                     | Body / Query                                           | Success                              | Notes                                   |
| ------ | ------------------------ | ------------------------------------------------------ | ------------------------------------ | --------------------------------------- |
| GET    | `/boards`                | `?filter=all\|owned\|shared\|starred&sort=&q=&cursor=` | 200 `{boards[], nextCursor}`         | Cursor pagination, 24/page              |
| POST   | `/boards`                | `{name?, templateId?}`                                 | 201 `{board}`                        | Creator becomes OWNER                   |
| GET    | `/boards/:id`            | —                                                      | 200 `{board, myRole, members[]}`     | 403/404                                 |
| PATCH  | `/boards/:id`            | `{name?}`                                              | 200 `{board}`                        | Owner only. Broadcasts `board:renamed`  |
| DELETE | `/boards/:id`            | —                                                      | 204                                  | Soft delete. Broadcasts `board:deleted` |
| POST   | `/boards/:id/restore`    | —                                                      | 200 `{board}`                        | Owner only, within 30 days              |
| DELETE | `/boards/:id/permanent`  | `{confirmName}`                                        | 204                                  | Name must match exactly                 |
| POST   | `/boards/:id/duplicate`  | —                                                      | 201 `{board}`                        | No members or links copied              |
| POST   | `/boards/:id/star`       | `{starred:boolean}`                                    | 200                                  | `[P2]`                                  |
| GET    | `/boards/:id/access`     | `?shareToken=&guestId=`                                | 200 `{role, joinable, requiresName}` | Drives the Phase 12 guard               |
| GET    | `/boards/:id/snapshot`   | —                                                      | 200 `{objects[], seq, meta}`         | Snapshot + tail ops, merged server-side |
| GET    | `/boards/:id/operations` | `?sinceSeq=&limit=`                                    | 200 `{ops[], hasMore}`               | Reconnect gap-fill fallback             |
| PUT    | `/boards/:id/thumbnail`  | multipart                                              | 200 `{url}`                          | Client-rendered JPEG                    |

### Members and sharing

| Method | Path                            | Body               | Success                                            | Notes                            |
| ------ | ------------------------------- | ------------------ | -------------------------------------------------- | -------------------------------- |
| GET    | `/boards/:id/members`           | —                  | 200 `{members[]}`                                  |                                  |
| POST   | `/boards/:id/members`           | `{emails[], role}` | 200 `{added[], invited[]}`                         | Owner only                       |
| PATCH  | `/boards/:id/members/:memberId` | `{role}`           | 200                                                | Owner only. Emits `role:changed` |
| DELETE | `/boards/:id/members/:memberId` | —                  | 204                                                | Emits `access:revoked`           |
| DELETE | `/boards/:id/members/me`        | —                  | 204                                                | "Leave board"                    |
| GET    | `/boards/:id/share-link`        | —                  | 200 `{token, role, url}` \| `null`                 |                                  |
| POST   | `/boards/:id/share-link`        | `{role}`           | 201 `{token, url}`                                 | Creates or replaces              |
| DELETE | `/boards/:id/share-link`        | —                  | 204                                                | Revokes; ejects link users       |
| GET    | `/share/:token`                 | —                  | 200 `{boardId, boardName, ownerName, activeCount}` | **Public, no auth**              |
| POST   | `/share/:token/join`            | `{guestId, name}`  | 200 `{boardId, role}`                              | Creates a guest `BoardMember`    |

### Uploads

| Method | Path               | Body                            | Success                           | Notes                                  |
| ------ | ------------------ | ------------------------------- | --------------------------------- | -------------------------------------- |
| POST   | `/uploads/presign` | `{filename, contentType, size}` | 200 `{uploadUrl, publicUrl, key}` | Validates type and size before issuing |
| POST   | `/uploads/confirm` | `{key}`                         | 200 `{url}`                       | Verifies existence; sanitizes SVG      |

**Do not proxy image bytes through the Node server.** Presigned direct-to-S3 uploads keep the event loop free (decision D-12).

---

## Appendix D — WebSocket protocol

### Message envelope

Keys are terse because these fly at 20 Hz per user.

```ts
type ClientMessage =
  | { t: 'join'; boardId: string; sinceSeq: number }
  | { t: 'op'; op: ClientOp }
  | { t: 'op_batch'; ops: ClientOp[] }
  | { t: 'cursor'; x: number; y: number }
  | { t: 'sel'; ids: string[] }
  | { t: 'stroke'; id: string; pts: number[]; done: boolean }
  | { t: 'xform'; ids: string[]; dx: number; dy: number }
  | { t: 'ping' }

type ServerMessage =
  | {
      t: 'join_ack'
      seq: number
      role: Role
      sessionId: string
      colour: string
      users: PresenceUser[]
    }
  | { t: 'op_batch'; ops: ServerOp[] }
  | { t: 'ack'; ids: string[]; seqs: number[] }
  | { t: 'nack'; id: string; code: string; message: string }
  | { t: 'presence_join'; user: PresenceUser }
  | { t: 'presence_leave'; sessionId: string }
  | { t: 'cursor'; sessionId: string; x: number; y: number }
  | { t: 'sel'; sessionId: string; ids: string[] }
  | { t: 'stroke'; sessionId: string; id: string; pts: number[]; done: boolean }
  | { t: 'xform'; sessionId: string; ids: string[]; dx: number; dy: number }
  | { t: 'board_renamed'; name: string }
  | { t: 'board_deleted' }
  | { t: 'role_changed'; role: Role }
  | { t: 'access_revoked' }
  | { t: 'pong' }

interface ClientOp {
  id: string // client-generated uuid — the idempotency key
  type: 'CREATE' | 'UPDATE' | 'DELETE'
  objectId: string
  payload: unknown // full object for CREATE, PARTIAL for UPDATE, {} for DELETE
}

interface ServerOp extends ClientOp {
  seq: number
  actorSessionId: string
}
```

### Ops versus presence

|                              | Ops                         | Presence                                            |
| ---------------------------- | --------------------------- | --------------------------------------------------- |
| Examples                     | create/update/delete object | cursor, selection, in-progress stroke, drag preview |
| Persisted                    | **Yes**, to Postgres        | **Never**                                           |
| Sequence number              | Yes                         | No                                                  |
| Acknowledged                 | Yes                         | No                                                  |
| Queued in the outbox offline | Yes                         | No — dropped                                        |
| Rate                         | Low                         | High — 20 Hz per user                               |
| Lost message                 | Data loss, unacceptable     | A cursor stutters, irrelevant                       |

### Close codes

| Code | Meaning                             | Client reaction                                         |
| ---- | ----------------------------------- | ------------------------------------------------------- |
| 1000 | Normal                              | No reconnect                                            |
| 1001 | Going away                          | No reconnect                                            |
| 1006 | Abnormal (network)                  | Reconnect with backoff                                  |
| 4001 | Unauthorized                        | Do not reconnect. Refresh the token, reconnect **once** |
| 4003 | Forbidden (role revoked)            | Do not reconnect. Show S-17                             |
| 4004 | Board not found / deleted           | Do not reconnect. Show S-18/S-19                        |
| 4029 | Rate limited / too many connections | Reconnect after 30 s                                    |

### Heartbeat

Client pings every 25 s. No pong within 10 s means the connection is dead — reconnect. **Do not rely on the `close` event; a half-open TCP connection can hang for minutes.** Server terminates any socket silent for 60 s.

---

## Appendix E — Data model

```prisma
model User {
  id            String   @id @default(uuid())
  email         String   @unique
  emailLower    String   @unique
  passwordHash  String?
  displayName   String   @db.VarChar(40)
  avatarUrl     String?
  googleId      String?  @unique
  emailVerified Boolean  @default(false)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  ownedBoards   Board[]        @relation("BoardOwner")
  memberships   BoardMember[]
  operations    Operation[]
  refreshTokens RefreshToken[]

  @@index([emailLower])
}

model RefreshToken {
  id        String    @id @default(uuid())
  userId    String
  tokenHash String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  userAgent String?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
}

model Board {
  id             String    @id @default(uuid())
  name           String    @db.VarChar(80) @default("Untitled board")
  ownerId        String
  thumbnailUrl   String?
  currentSeq     Int       @default(0)
  objectCount    Int       @default(0)
  deletedAt      DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  lastActivityAt DateTime  @default(now())

  owner      User          @relation("BoardOwner", fields: [ownerId], references: [id])
  members    BoardMember[]
  operations Operation[]
  snapshots  Snapshot[]
  shareLinks ShareLink[]

  @@index([ownerId, deletedAt])
  @@index([lastActivityAt])
}

model BoardMember {
  id         String   @id @default(uuid())
  boardId    String
  userId     String?
  guestId    String?
  guestName  String?  @db.VarChar(40)
  role       Role
  addedById  String?
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())

  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)
  user  User? @relation(fields: [userId],  references: [id], onDelete: Cascade)

  @@unique([boardId, userId])
  @@unique([boardId, guestId])
  @@index([userId])
}

enum Role { OWNER EDITOR VIEWER }

model ShareLink {
  id          String    @id @default(uuid())
  boardId     String
  token       String    @unique
  role        Role
  revokedAt   DateTime?
  createdById String
  createdAt   DateTime  @default(now())

  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@index([boardId])
  @@index([token])
}

model Operation {
  id         String   @id              // CLIENT-generated uuid — idempotency key
  boardId    String
  seq        Int                       // server-assigned, monotonic per board
  type       OpType
  objectId   String
  payload    Json
  actorId    String?
  actorGuest String?
  createdAt  DateTime @default(now())

  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)
  actor User? @relation(fields: [actorId], references: [id], onDelete: SetNull)

  @@unique([boardId, seq])
  @@index([boardId, seq])
  @@index([boardId, objectId])
}

enum OpType { CREATE UPDATE DELETE }

model Snapshot {
  id        String   @id @default(uuid())
  boardId   String
  seq       Int
  state     Json
  createdAt DateTime @default(now())

  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@index([boardId, seq])
}
```

### Snapshot strategy

| Rule         | Value                                                       |
| ------------ | ----------------------------------------------------------- |
| When         | Every 500 ops, and on the last client leaving               |
| How          | Replay from the previous snapshot forward, never from seq 0 |
| Retention    | Latest 3 per board                                          |
| Op retention | Keep all ops                                                |
| Load path    | `latest snapshot` + `ops WHERE seq > snapshot.seq`          |
| Generation   | Background job, never on the request path                   |

---

## Appendix F — Object schemas

```ts
type ObjectId = string // uuid v4, generated client-side

interface BaseObject {
  id: ObjectId
  type: 'stroke' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'sticky' | 'text' | 'image'
  x: number // canvas coords, top-left of the bounding box
  y: number
  width: number
  height: number
  rotation: number // degrees, 0–359.99
  zIndex: string // FRACTIONAL index, lexicographically ordered
  opacity: number // 0–1
  createdBy: string
  createdAt: number // client ms timestamp, DISPLAY ONLY, never for ordering
  updatedAt: number
}

interface StrokeObject extends BaseObject {
  type: 'stroke'
  points: number[] // FLAT array [x0,y0,p0, x1,y1,p1, …], stride 3
  color: string // #RRGGBB
  strokeWidth: number // 1–24
  simplified: boolean
}

interface ShapeObject extends BaseObject {
  type: 'rect' | 'ellipse' | 'line' | 'arrow'
  stroke: string
  strokeWidth: number
  fill: string | 'none'
  cornerRadius?: number // rect only
  arrowStart?: boolean // arrow only
  arrowEnd?: boolean
}

interface StickyObject extends BaseObject {
  type: 'sticky'
  text: string // max 2000 chars
  color: string // one of the 8 palette colours
  fontSize: number | 'auto'
  textAlign: 'left' | 'center' | 'right'
}

interface TextObject extends BaseObject {
  type: 'text'
  text: string // max 5000 chars
  color: string
  fontSize: number // 8–128
  bold: boolean
  italic: boolean
  textAlign: 'left' | 'center' | 'right'
}

interface ImageObject extends BaseObject {
  type: 'image'
  url: string // never base64
  naturalWidth: number
  naturalHeight: number
  cornerRadius: number
}
```

### Validation example

Every numeric field carries explicit finite bounds. `NaN` and `Infinity` are rejected — an `Infinity` in a coordinate propagates through the renderer and blanks the canvas for **every** user in the room.

```ts
export const CreateStrokeSchema = z.object({
  id: z.string().uuid(),
  type: z.literal('stroke'),
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
  width: z.number().finite().min(0).max(2_000_000),
  height: z.number().finite().min(0).max(2_000_000),
  rotation: z.number().min(0).max(360),
  opacity: z.number().min(0).max(1),
  zIndex: z.string().min(1).max(64),
  points: z.array(z.number().finite()).min(6).max(30_000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  strokeWidth: z.number().min(1).max(24),
})
```

---

## Appendix G — Design tokens, zoning and motion

### Tokens — PRD §15, binding

| Token                               | Value                                                   | Use                          |
| ----------------------------------- | ------------------------------------------------------- | ---------------------------- |
| `--color-bg-canvas`                 | `#FAFAFA`                                               | Canvas background            |
| `--color-bg-app`                    | `#FFFFFF`                                               | Panels, header               |
| `--color-bg-subtle`                 | `#F4F4F5`                                               | Dashboard background         |
| `--color-border`                    | `#E4E4E7`                                               | Dividers, panel edges        |
| `--color-text-primary`              | `#18181B`                                               | Body text                    |
| `--color-text-secondary`            | `#71717A`                                               | Metadata, hints              |
| `--color-accent`                    | `#4F46E5`                                               | Primary buttons, active tool |
| `--color-danger`                    | `#DC2626`                                               | Delete, errors               |
| `--color-success`                   | `#16A34A`                                               | Connected, confirmations     |
| `--color-warning`                   | `#D97706`                                               | Reconnecting                 |
| `--radius-sm` / `md` / `lg`         | 4 / 8 / 12 px                                           | Controls / panels / modals   |
| `--shadow-panel`                    | `0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06)` | Floating panels              |
| `--space-*`                         | 4, 8, 12, 16, 24, 32, 48 px                             | 4 px base scale              |
| `--font-sans`                       | `Inter, system-ui, -apple-system, sans-serif`           | All UI                       |
| `--duration-fast` / `base` / `slow` | 120 / 200 / 320 ms                                      | Micro / standard / modal     |
| `--easing-standard`                 | `cubic-bezier(0.2, 0, 0, 1)`                            | Default easing               |

### Frozen palettes

**Presence — 12 colours, round-robin per room, assigned server-side.** Frozen because a user's colour must render identically for every participant.

```
#EF4444  #F97316  #EAB308  #84CC16  #22C55E  #14B8A6
#06B6D4  #3B82F6  #6366F1  #A855F7  #EC4899  #F43F5E
```

**Sticky notes — 8 colours.** Frozen because a sticky's colour is a persisted object property.

```
#FEF08A yellow   #FED7AA orange   #FBCFE8 pink    #FECACA red
#E9D5FF purple   #BFDBFE blue     #BBF7D0 green   #E4E4E7 grey
```

### Skill zoning

| Zone           | Screens                  | Skills that fire                                 | Forbidden                                 |
| -------------- | ------------------------ | ------------------------------------------------ | ----------------------------------------- |
| Marketing      | S-01                     | all five visual skills                           | —                                         |
| Auth           | S-02 … S-06              | ui-ux-pro-max, emil, design-taste (type/colour)  | gpt-taste                                 |
| Product chrome | S-07, S-08, S-09, S-16   | ui-ux-pro-max, emil, framer-motion (lazy)        | gpt-taste, high-end-visual                |
| Board chrome   | S-10 chrome, S-12 … S-15 | ui-ux-pro-max, emil                              | gpt-taste, high-end-visual, framer-motion |
| **Canvas**     | the 4 layers             | **none**                                         | all six                                   |
| System states  | S-17 … S-21              | ui-ux-pro-max, emil                              | gpt-taste, high-end-visual                |
| Guest          | S-11, S-22               | ui-ux-pro-max, emil, high-end-visual (join card) | gpt-taste                                 |

### Motion reference

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1); /* entering / exiting  */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1); /* on-screen movement  */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1); /* iOS-like drawer     */
--easing-standard: cubic-bezier(0.2, 0, 0, 1); /* PRD §15 default     */
```

| Element                  | Duration   |
| ------------------------ | ---------- |
| Button press feedback    | 100–160 ms |
| Tooltips, small popovers | 125–200 ms |
| Dropdowns, selects       | 150–250 ms |
| Modals, drawers          | 200–500 ms |

**The frequency gate:** 100+×/day → no animation, ever · tens ×/day → reduce drastically · occasional → standard · rare → may delight.

**Never** `ease-in`. **Never** `transition: all`. **Never** animate `width`/`height`/`top`/`left`. **Never** from `scale(0)`. **Never** any animation on a canvas layer.

---

## Appendix H — Keyboard shortcuts

| Shortcut               | Action                          | Context |
| ---------------------- | ------------------------------- | ------- |
| `V`                    | Select tool                     | Board   |
| `H`                    | Hand / pan tool                 | Board   |
| `P`                    | Pen tool                        | Board   |
| `E`                    | Eraser tool                     | Board   |
| `R`                    | Rectangle                       | Board   |
| `O`                    | Ellipse                         | Board   |
| `L`                    | Line                            | Board   |
| `A`                    | Arrow                           | Board   |
| `N`                    | Sticky note                     | Board   |
| `T`                    | Text                            | Board   |
| `Space` (hold)         | Temporary pan                   | Board   |
| `Cmd/Ctrl + Z`         | Undo                            | Board   |
| `Cmd/Ctrl + Shift + Z` | Redo                            | Board   |
| `Cmd/Ctrl + C`         | Copy                            | Board   |
| `Cmd/Ctrl + X`         | Cut                             | Board   |
| `Cmd/Ctrl + V`         | Paste                           | Board   |
| `Cmd/Ctrl + D`         | Duplicate                       | Board   |
| `Cmd/Ctrl + A`         | Select all                      | Board   |
| `Delete` / `Backspace` | Delete selection                | Board   |
| `Escape`               | Deselect / cancel / close modal | Global  |
| `Arrow keys`           | Nudge 1 px                      | Board   |
| `Shift + Arrow`        | Nudge 10 px                     | Board   |
| `Cmd/Ctrl + Scroll`    | Zoom                            | Board   |
| `Cmd/Ctrl + 0`         | Reset zoom to 100%              | Board   |
| `Cmd/Ctrl + 1`         | Zoom to fit                     | Board   |
| `Cmd/Ctrl + +` / `-`   | Zoom in / out                   | Board   |
| `]`                    | Bring forward                   | Board   |
| `Cmd/Ctrl + ]`         | Bring to front                  | Board   |
| `[`                    | Send backward                   | Board   |
| `Cmd/Ctrl + [`         | Send to back                    | Board   |
| `?`                    | Shortcuts modal                 | Global  |
| `Cmd/Ctrl + Enter`     | Submit form                     | Forms   |

**Rule:** every shortcut is disabled while a text input or the on-canvas text editor has focus, **except `Escape` and `Cmd/Ctrl+Enter`**.

---

## Appendix I — Canonical copy

All strings live in `apps/web/src/lib/strings.ts` and are used verbatim.

### Tone rules

Second person, present tense. Never blame the user. Every error tells the user what to do next. No exclamation marks except "Copied!" and celebratory empty states. Never expose internal identifiers, stack traces or error codes — log them, show a friendly message with a short correlation ID.

### Errors

| Situation                 | Message                                                                        | Action                                           |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Wrong credentials         | "That email or password didn't match. Try again."                              | —                                                |
| Rate limited (login)      | "Too many attempts. Try again in {N} minutes."                                 | —                                                |
| Email already registered  | "An account already exists for this email."                                    | "Log in instead"                                 |
| Weak password             | "Password needs at least 8 characters, including a letter and a number."       | —                                                |
| No board access           | "You don't have access to this board."                                         | "Ask the owner for access" / "Back to dashboard" |
| Board not found           | "This board doesn't exist, or it was deleted."                                 | "Back to dashboard"                              |
| Board deleted while open  | "The owner deleted this board."                                                | "Back to dashboard"                              |
| Access revoked while open | "Your access to this board was removed."                                       | "Back to dashboard"                              |
| Disconnected              | "Offline — your changes are saved locally and will sync when you're back."     | "Retry now"                                      |
| Reconnecting              | "Reconnecting… (attempt {N})"                                                  | —                                                |
| Syncing                   | "Syncing {N} changes…"                                                         | —                                                |
| Op rejected               | "That change couldn't be saved."                                               | "Undo"                                           |
| Upload too large          | "Images must be under 10 MB."                                                  | —                                                |
| Unsupported file          | "We support PNG, JPG, GIF, WebP, and SVG."                                     | —                                                |
| Upload failed             | "Upload failed."                                                               | "Retry" / "Remove"                               |
| Board too large           | "This board is getting large. Consider splitting it up."                       | "Dismiss"                                        |
| Generic server error      | "Something went wrong on our end. We're looking into it." + `Ref: {8-char id}` | "Retry"                                          |
| Unsupported browser       | "CoBoard needs a modern browser. Try Chrome, Firefox, Edge, or Safari."        | —                                                |

### Empty states

| Screen                  | Headline                                                                                                         | Body                                            | CTA            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------- |
| Dashboard, no boards    | "Nothing here yet"                                                                                               | "Create your first board and invite your team." | "New board"    |
| Dashboard, filter empty | "No boards match that filter"                                                                                    | —                                               | "Clear filter" |
| Trash empty             | "Trash is empty"                                                                                                 | "Deleted boards appear here for 30 days."       | —              |
| Board, no objects       | "Pick a tool and start drawing" — faint, centred, arrow to the toolbar. Fades permanently after the first object | —                                               | —              |
| Search, no results      | "No boards found for '{query}'"                                                                                  | —                                               | "Clear search" |

### Guest flow

| Situation     | Message                                                       |
| ------------- | ------------------------------------------------------------- |
| Invalid token | "This link isn't valid. Ask whoever shared it for a new one." |
| Revoked link  | "This link has been turned off."                              |
| Board deleted | "This board no longer exists."                                |
| Board full    | "This board is full right now. Try again in a few minutes."   |
| Name empty    | "Enter a name so others know who you are."                    |
| Joined        | "You're in as {name}"                                         |
| Guest bar     | "You're a guest. Sign up to save your boards."                |

---

## Appendix J — Performance budgets and scalability

| Metric                           | Budget                      | Measured how      | Enforced             |
| -------------------------------- | --------------------------- | ----------------- | -------------------- |
| Landing page LCP                 | ≤ 1.5 s on 4G               | Lighthouse        | Phase 15             |
| Dashboard interactive            | ≤ 2.0 s                     | Lighthouse        | Phase 15             |
| Board first paint, 500 objects   | ≤ 1.5 s                     | Custom perf mark  | Phase 15             |
| Board first paint, 5,000 objects | ≤ 3.0 s                     | Custom perf mark  | `AT-13`, Phase 8     |
| Drawing frame rate               | ≥ 55 fps with 5,000 objects | Chrome perf panel | Phases 3, 15         |
| Pan/zoom frame rate              | ≥ 55 fps                    | Chrome perf panel | Phase 2              |
| Input-to-local-pixel             | ≤ 16 ms                     | Instrumented      | Phase 3              |
| Local-input-to-remote-render p95 | ≤ 250 ms                    | Instrumented      | Phase 9              |
| Cursor update rate               | 20 Hz send, interpolated    | Code review       | Phase 10             |
| Initial JS bundle (gz)           | ≤ 250 KB                    | Bundle analyzer   | **CI gate**, Phase 1 |
| Board route chunk (gz)           | ≤ 200 KB                    | Bundle analyzer   | **CI gate**, Phase 1 |
| Memory, 5,000 objects            | ≤ 300 MB heap               | Memory profiler   | Phase 15             |
| Typical WebSocket op             | ≤ 2 KB                      | Network tab       | Phase 9              |

### Scalability targets (v1)

1,000 registered users · 50 concurrent users per board · 200 concurrent boards · 50,000 objects max per board (soft warning at 10,000) · 100 ops/second sustained per board.

### Reliability

Target uptime 99.5%. **Zero committed-op loss** — stricter than uptime: the system may be briefly unavailable, but must never lose an acknowledged operation. Server restart must not lose in-flight ops. Automated daily backups with a **tested** restore procedure.

---

## Appendix K — Security checklist

- [ ] All traffic over HTTPS/WSS; HSTS with 1-year max-age
- [ ] bcrypt cost 12; password hashes never leave the server
- [ ] Generic auth errors — never reveal whether an email is registered
- [ ] Rate limits: login 5/15 min per email + 20/15 min per IP; ops 100/s per session; uploads 20/h per user
- [ ] Share tokens 32 bytes from `crypto.randomBytes`, base64url
- [ ] Every socket message authorized server-side
- [ ] Every payload validated with Zod at the boundary — reject, never coerce
- [ ] No `dangerouslySetInnerHTML` anywhere (ESLint rule)
- [ ] SVG uploads sanitized with DOMPurify server-side
- [ ] Uploads validated by magic bytes, not the client-supplied MIME type
- [ ] CORS restricted to an explicit origin allow-list
- [ ] CSP: `default-src 'self'; img-src 'self' data: blob: <s3-domain>; connect-src 'self' <ws-domain>`
- [ ] Prisma parameterizes all queries — no raw SQL interpolation
- [ ] Secrets in environment variables; `.env` git-ignored; `.env.example` committed
- [ ] `npm audit` in CI blocking on high/critical
- [ ] No user IDs, emails or tokens in client-visible error messages

### Token strategy

| Token     | Storage                                                     | Lifetime         |
| --------- | ----------------------------------------------------------- | ---------------- |
| Access    | **In memory only**                                          | 15 min           |
| Refresh   | `httpOnly`, `Secure`, `SameSite=Lax` cookie, rotated on use | 30 days          |
| WS ticket | In memory                                                   | 60 s, single use |

Refresh rotation includes **reuse detection** — a revoked token being presented indicates theft: revoke the entire family and force re-login.

---

## Appendix L — Acceptance tests by phase

All 28 scenarios. The numbering gaps in the source PRD are intentional category spacing.

### Core collaboration

| ID      | Scenario                             | Expected                                          | Phase |
| ------- | ------------------------------------ | ------------------------------------------------- | ----- |
| `AT-01` | Two windows, A draws a stroke        | Appears in B within 250 ms                        | 9     |
| `AT-02` | A and B draw simultaneously for 30 s | Boards identical; object counts match exactly     | 9     |
| `AT-03` | A moves object X while B recolours X | Final state has both the position and the colour  | 9     |
| `AT-04` | A deletes X while B moves it         | Gone on both. No error, no zombie                 | 9     |
| `AT-05` | Both set X's fill within 50 ms       | Converge to the later server-sequenced value      | 9     |
| `AT-06` | B joins mid-session                  | Sees the complete board and all live cursors      | 10    |
| `AT-07` | A closes the tab                     | A's cursor and avatar disappear from B within 5 s | 10    |
| `AT-08` | 5 users draw for 2 minutes           | All converge; no dropped ops; frame rate holds    | 10    |

### Persistence

| ID      | Scenario                             | Expected                                      | Phase |
| ------- | ------------------------------------ | --------------------------------------------- | ----- |
| `AT-10` | Draw, refresh                        | Everything present, same position and z-order | 8     |
| `AT-11` | Draw, close browser, reopen tomorrow | Everything present                            | 8     |
| `AT-12` | Restart the server mid-session       | Clients reconnect automatically; no ops lost  | 11    |
| `AT-13` | Board with 5,000 objects             | Loads under 3 s and is interactive            | 8     |

### Permissions

| ID      | Scenario                                        | Expected                                                     | Phase |
| ------- | ----------------------------------------------- | ------------------------------------------------------------ | ----- |
| `AT-20` | Viewer tries to draw                            | Toolbar disabled; a forged socket op is rejected server-side | 12    |
| `AT-21` | Non-member opens the board URL                  | Access-denied screen, board name hidden                      | 12    |
| `AT-22` | Owner revokes a link while a guest draws        | Guest ejected within 10 s with the correct message           | 12    |
| `AT-23` | Owner deletes the board with 3 users connected  | All 3 see the "board deleted" screen                         | 12    |
| `AT-24` | Editor calls the delete-board endpoint directly | 403                                                          | 12    |

### Network chaos — all ship-blocking

| ID      | Scenario                                     | Expected                                                 | Phase |
| ------- | -------------------------------------------- | -------------------------------------------------------- | ----- |
| `AT-30` | Kill wifi, draw 10 strokes, restore          | All 10 appear for everyone; nothing duplicated           | 11    |
| `AT-31` | A and B both offline, both draw, both return | Both sets merge; both converge                           | 11    |
| `AT-32` | Throttle to 3G with 400 ms latency           | App usable; local drawing instant                        | 11    |
| `AT-33` | Kill the connection mid-stroke               | Commits fully or does not exist. **Never a half-stroke** | 11    |
| `AT-34` | 30 rapid disconnect/reconnect cycles         | No duplicate ops, no memory leak, no zombie sockets      | 11    |
| `AT-35` | Malformed op via the console                 | Server rejects, does not crash; others unaffected        | 11    |

### Undo

| ID      | Scenario                                  | Expected                                  | Phase |
| ------- | ----------------------------------------- | ----------------------------------------- | ----- |
| `AT-40` | A draws, B draws, A undoes                | Only A's stroke disappears                | 9     |
| `AT-41` | A moves an object, B deletes it, A undoes | No-op. No crash, no resurrection          | 9     |
| `AT-42` | A performs 10 actions and undoes 10 times | Board returns to A's starting state       | 6     |
| `AT-43` | A undoes 5 then redoes 5                  | Identical to before the undos             | 6     |
| `AT-44` | A undoes, acts, then presses redo         | Redo does nothing — the stack was cleared | 6     |

---

## Appendix M — Edge cases by phase

All 22 from FLOWS §12.5.

| #      | Situation                         | Behaviour                                                                 | Phase |
| ------ | --------------------------------- | ------------------------------------------------------------------------- | ----- |
| `E-01` | Two tabs, same user               | Both work. One avatar (dedupe by user id), two cursors                    | 10    |
| `E-02` | Tab backgrounded 30 min           | Force a reconnect check on `visibilitychange` → visible                   | 11    |
| `E-03` | User's clock is wrong             | Never trust client timestamps. Server seq is the only authority           | 9     |
| `E-04` | Extreme coordinates               | Clamp to ±1,000,000; reject out-of-range server-side                      | 2     |
| `E-05` | 50 MB image pasted                | Reject before upload; check `File.size` client-side first                 | 13    |
| `E-06` | Non-image clipboard data          | Plain text → text object. Otherwise ignore silently                       | 5     |
| `E-07` | Dragging 500 objects              | One op message. Presence throttled to 10 Hz above 100 selected            | 4     |
| `E-08` | Tool switch during a drag         | Ignore until the interaction finishes                                     | 4     |
| `E-09` | `Escape` during a stroke          | Cancel entirely. Nothing committed or broadcast                           | 3     |
| `E-10` | Window resized mid-drag           | Recompute backing store, preserve centre, keep the drag alive             | 2     |
| `E-11` | 2 px object at 500% zoom          | Still hit-testable; 8 px minimum handle target                            | 4     |
| `E-12` | 5,000 objects at 10% zoom         | Cull off-screen; simplified paths below 25%                               | 2     |
| `E-13` | Op for an unknown object id       | Log, ignore; fresh snapshot after 3 in a minute                           | 9     |
| `E-14` | `seq <= lastAppliedSeq`           | Ignore — duplicate                                                        | 9     |
| `E-15` | `seq > lastAppliedSeq + 1`        | Buffer, request the missing range, never apply out of order               | 9     |
| `E-16` | Double-click "New board"          | Button disables on first click. One board                                 | 8     |
| `E-17` | Session expires with a board open | Keep the socket, refresh silently, banner on failure. **Never lose work** | 7     |
| `E-18` | `localStorage` blocked            | In-memory fallback. App works. **Show no error**                          | 11    |
| `E-19` | Simultaneous board rename         | Last write wins. Both see the final name                                  | 8     |
| `E-20` | Very long display name            | Truncate to 20 chars, full name on hover                                  | 10    |
| `E-21` | Slow 3G board load                | 30 s snapshot timeout, then inline retry. **Never a forever spinner**     | 12    |
| `E-22` | Export an empty board             | Block it: "There's nothing to export yet."                                | 13    |

`E-17` is the binding requirement behind the dangling `FR-BOARD-041` reference — see defect `D-1` in `RULES.md` §2.4.

---

## Appendix N — Deferred backlog

**Do not build these.** They are recorded so it is clear they were considered and deliberately deferred. Building one is a scope violation under PRD §2.2 and risk `R-5`.

### P2 requirements

| ID               | Item                  | Note                                                                                                                                         |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-BOARD-008`   | Star / favourite      | Dashboard toggle, "Starred" tab pinning                                                                                                      |
| `FR-BOARD-009`   | Templates             | Blank, Retrospective, Kanban, Mind map, Flowchart. A template is just a predefined object set inserted at creation. Would also activate S-09 |
| `FR-CANVAS-017`  | Grouping              | Marked `[P1]` in its heading but `[P2]` / "Do not build" in its body. See defect `D-2` — the body wins                                       |
| `FR-CANVAS-021`  | Grid and snap-to-grid | Toggleable dot grid at 20 canvas px. Canvas layer 0 is reserved for it                                                                       |
| `FR-COMMENT-001` | Comment threads       | Pinned to a coordinate or object, with replies and resolve. Deferred entirely                                                                |
| `FR-EXPORT-002`  | Export as SVG         |                                                                                                                                              |
| `FR-EXPORT-003`  | Export board JSON     | For debugging and re-import                                                                                                                  |
| `FR-SET-002`     | Appearance / theme    | Light / dark / system for app chrome. **The canvas stays light in v1**                                                                       |

### P2 sub-features inside shipped requirements

| Item                                  | Parent          | Note                                                                     |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| Commenter role                        | `FR-SHARE-001`  | The role matrix has four rows; only three ship                           |
| Ownership transfer                    | `FR-SHARE-001`  |                                                                          |
| "Request access" button               | `FR-SHARE-005`  | S-17 ships without it                                                    |
| Follow-user                           | `FR-RT-004`     | Click an avatar to follow their viewport                                 |
| Off-screen cursor chevrons            | FLOWS §9.2      | Coloured chevron pinned to the viewport edge                             |
| Reject over-capacity joins            | `FR-RT-011`     | v1 admits them as viewers with a notice instead                          |
| Pixel eraser                          | `FR-CANVAS-006` | Splitting strokes is **explicitly out of scope**                         |
| Align / distribute                    | FLOWS §14.4     | Multi-selection panel                                                    |
| Right-drag to pan                     | FLOWS §8.2.4    | The other four pan triggers ship                                         |
| Bounding-box rendering below 10% zoom | TRD §7.6        | Simplified paths below 25% do ship                                       |
| Op pruning                            | TRD §3.4        | Prune ops older than the second-newest snapshot                          |
| Spatial index                         | TRD §7.4        | **Do not build preemptively.** Linear culling is fine to ~10,000 objects |
| S-22 onboarding tour                  | PRD §6          |                                                                          |

### Stretch — explicitly not built

| Item                                       | Note                                                        |
| ------------------------------------------ | ----------------------------------------------------------- |
| Version history with time-travel scrubbing | The op log makes it possible later. **Do not build the UI** |

### Non-goals — never build

Video/voice chat · native mobile apps · offline-first PWA with full local persistence · rich document editing · payments · collaborative code editing · SSO/SAML · AI features of any kind.

### Recorded deviation awaiting sign-off

| Item                                                                             | Status                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A display typeface (Clash Display, PP Editorial New) for S-01 marketing headings | **Not adopted.** Would satisfy three design skills whose font bans currently lose to PRD §15 (conflict `C-1`). PRD §15 says `--font-sans` applies to "All UI". Requires explicit sign-off. Do not implement unilaterally |

---

## Appendix O — Risks and mitigating phases

| #     | Risk                                                          | Likelihood    | Impact   | Mitigation                                                                                                                     | Phase        |
| ----- | ------------------------------------------------------------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `R-1` | Conflict resolution subtly wrong; clients diverge             | High          | Critical | Convergence test harness in week 4. Keep resolution rules dead simple. Debug panel with op count and state hash per client     | **11**       |
| `R-2` | Canvas performance collapses past a few thousand objects      | High          | High     | Layered canvases, viewport culling, dirty-rect rendering, and a seeded 10k stress board committed from week 1                  | **1, 2, 15** |
| `R-3` | Per-user undo interacts badly with remote ops                 | High          | High     | Implement the inverse-op model in TRD §8 exactly. **Do not invent a variant.** Separate `applyAndEmit` / `applyRemoteOp` paths | **6, 9**     |
| `R-4` | Team builds the fun canvas parts and skips error/empty states | **Very High** | Medium   | Definition of Done includes them. Reviewers reject PRs without them                                                            | **14**       |
| `R-5` | Scope creep — someone builds comments, or a font picker       | High          | Medium   | PRD §2.2 is binding. New scope goes to Appendix N, not into the sprint                                                         | All          |
| `R-6` | WebSocket reconnection edge case loses ops                    | Medium        | Critical | Sequence numbers + client-generated op IDs + server-side idempotency. `AT-30`–`AT-35` are ship-blocking                        | **11**       |
| `R-7` | Coordinate-space confusion (screen vs canvas)                 | **Very High** | Medium   | Two branded TypeScript types so the compiler catches mixups                                                                    | **1, 2**     |
| `R-8` | Memory leaks from event listeners and socket handlers         | Medium        | Medium   | Every `useEffect` returns a cleanup. Profile the heap after 30 minutes of use                                                  | **15**       |
| `R-9` | Everyone works on the canvas file at once; merge hell         | Medium        | Medium   | Strict module boundaries. Owners assigned per module                                                                           | **1** (§5.1) |

---

## Appendix P — Open questions

Carried forward **unresolved**. Do not guess an answer — escalate to the named owner.

| #     | Question                                                                                        | Owner             | Needed by     |
| ----- | ----------------------------------------------------------------------------------------------- | ----------------- | ------------- |
| `Q-1` | Do guests persist as board members after leaving, or vanish entirely?                           | Product           | Phase 10 (M3) |
| `Q-2` | Does a board have a hard object cap, or only a soft warning?                                    | Eng lead          | Phase 11 (M4) |
| `Q-3` | Do we ship dark mode for the canvas or only the chrome?                                         | Design            | Phase 14 (M5) |
| `Q-4` | Is the 30-day trash retention configurable per board?                                           | Product           | Phase 14 (M5) |
| `Q-5` | Adopt a display typeface for S-01 marketing headings, overriding PRD §15 for that surface only? | Eng lead + Design | Phase 14 (M5) |

`Q-5` is new, raised by conflict `C-1`. FLOWS §10.3 notes that `Q-1` currently has a working answer — guests remain listed for the session and are dropped once the board has been idle for 24 hours — but this is not ratified.

### Interim positions

Where a phase needs an answer before the owner provides one, use these and flag the assumption in the PR:

| #     | Interim position                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------- |
| `Q-1` | Guests persist as `BoardMember` rows and are swept after 24 hours of board idleness (FLOWS §10.3) |
| `Q-2` | Soft warning at 10,000 objects, hard cap at 50,000 per `MAX_OBJECTS_PER_BOARD` (PRD §7.2)         |
| `Q-3` | Chrome only. **The canvas stays light in v1** (PRD `FR-SET-002`)                                  |
| `Q-4` | Fixed at 30 days, not configurable                                                                |
| `Q-5` | Inter everywhere. Do not adopt a display face without sign-off                                    |

---

## Appendix Q — Definition of Done and workflow

### Definition of Done

A feature is done when **all eleven** are true. Not most.

1. Implements every acceptance criterion of its requirement ID
2. Handles loading, empty, error and offline states
3. Keyboard accessible with visible focus
4. Works at every breakpoint
5. Unit tests for logic; integration test for the happy path and at least one failure path
6. No new console errors or warnings
7. No TypeScript `any` introduced without a comment explaining why
8. Meets the relevant performance budget
9. Copy matches PRD §8 exactly
10. Reviewed and approved by one other person
11. Server-side authorization enforced where applicable

### Branches, commits, PRs

Branches `feat/…` `fix/…` `chore/…` `docs/…`. Conventional Commits — `feat(canvas): add rotation handle`. PRs include the requirement IDs implemented, a screenshot or clip for UI work, test evidence, and a note on performance impact. **PRs capped at ~400 changed lines** — a 2,000-line PR will not be reviewed properly, and everyone involved knows it.

### CI gates

| Gate                                       | Blocking                       |
| ------------------------------------------ | ------------------------------ |
| `tsc --noEmit`                             | Yes                            |
| ESLint, zero warnings                      | Yes                            |
| Unit + integration tests                   | Yes                            |
| Bundle size budget                         | Yes                            |
| Board-route animation-library import check | Yes                            |
| `npm audit` high/critical                  | Yes                            |
| Playwright e2e                             | Yes on `main`, advisory on PRs |
| Lighthouse CI                              | Advisory                       |

### Analytics events — PRD §9

`account_created` · `logged_in` · `board_created` · `board_opened` · `board_joined_as_guest` · `object_created` · `tool_selected` · `share_link_created` · `share_link_copied` · `export_completed` · `socket_disconnected` · `socket_reconnected` · `op_rejected` · `client_error`

Server-side operational metrics: connected sockets, ops/sec, op persist latency p50/p95/p99, broadcast fan-out latency, room count, snapshot generation time, error rate by endpoint.

### Local bootstrap

```bash
git clone <repo> && cd SharedBoard
cp .env.example .env
docker compose up -d           # postgres + redis
pnpm install
pnpm db:migrate
pnpm db:seed                   # includes the 10k-object stress board
pnpm dev                       # web :5173, server :3000
```

---

## Appendix R — Key architectural decisions

From TRD §17. Recorded so nobody re-opens a settled question without new information.

| #      | Decision                                              | Alternatives considered          | Rationale                                                                      |
| ------ | ----------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `D-1`  | Native WebSocket over Socket.IO                       | Socket.IO, SSE + POST            | Learning value; bundle size; the reconnection logic _is_ the project           |
| `D-2`  | Server-ordered LWW over CRDT/OT                       | Yjs, Automerge, custom OT        | Sufficient for spatially-separated objects; a library would hide the learning  |
| `D-3`  | Op log over a mutable objects table                   | Mutable rows + version column    | Free replay, idempotency and audit; snapshots solve the read cost              |
| `D-4`  | Canvas 2D over WebGL                                  | WebGL, SVG                       | Required by the brief; sufficient to 10k objects; SVG collapses past ~2k nodes |
| `D-5`  | Multiple canvas layers over one                       | Single canvas                    | Cursor movement must not redraw objects. Non-negotiable                        |
| `D-6`  | DOM textarea overlay for text editing                 | Canvas-rendered caret            | IME, mobile keyboards, spellcheck and a11y come free                           |
| `D-7`  | Zustand over Redux/Context                            | Redux Toolkit, Context, Jotai    | Readable outside React — essential for the rAF loop                            |
| `D-8`  | Fractional z-index over integers                      | Integer indices with renumbering | Avoids O(n) reorder storms; survives concurrent reordering                     |
| `D-9`  | Flat `number[]` for stroke points                     | `{x,y,p}[]`                      | ~3× smaller payloads; no per-point allocation                                  |
| `D-10` | Local per-user undo over global undo                  | Global shared history            | Global undo lets you revert a teammate's work                                  |
| `D-11` | Access token in memory, refresh in an httpOnly cookie | Both in localStorage             | XSS cannot exfiltrate an in-memory token or read an httpOnly cookie            |
| `D-12` | Presigned direct-to-S3 uploads                        | Proxy through Node               | Keeps the event loop free during large uploads                                 |
| `D-13` | Guests without accounts                               | Signup required                  | Persona B abandons at any signup wall                                          |
| `D-14` | Ops persisted before ack                              | Ack then persist                 | An acknowledged op must be durable, or the zero-loss guarantee is a lie        |

### Decisions added by this plan

Recorded in `RULES.md` §2.3 as conflicts `C-1`–`C-8`, resolved against the six design skills:

| #     | Decision                                                                        | Loser                                       |
| ----- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| `C-1` | Inter on all 22 screens                                                         | Three skill font bans                       |
| `C-2` | Phosphor icons, one family                                                      | Lucide / Heroicons                          |
| `C-3` | CSS-first motion; Framer Motion non-canvas only; **no GSAP**                    | `gpt-taste`'s GSAP mandate                  |
| `C-4` | PRD §7.1 bundle budgets are blocking CI gates                                   | Any library breaching them                  |
| `C-5` | Per-surface skill zoning                                                        | Applying landing-page grammar to product UI |
| `C-6` | `emil-design-eng`'s frequency framework governs; canvas is a no-decoration zone | Maximalist scroll choreography              |
| `C-7` | PRD §15 tokens binding; presence and sticky palettes frozen                     | Generated skill palettes                    |
| `C-8` | Tailwind 3.x                                                                    | Tailwind v4 guidance                        |

---

# 9. Document map

```
README.md                        Repo index
CLAUDE.md                        How to work here
RULES.md                         What is forbidden. Cite by rule ID
docs/
├── 01-PRD.md                    What to build. Requirement IDs, budgets, copy
├── 02-FLOWS.md                  Screens, routing, state machines, edge cases
├── 03-TRD.md                    Schemas, protocol, algorithms, decisions
└── 04-IMPLEMENTATION-PLAN.md    ← you are here
```

The three specification documents are preserved **exactly as delivered** and must not be edited. Corrections go in the defect register at [`../RULES.md`](../RULES.md) §2.4.
