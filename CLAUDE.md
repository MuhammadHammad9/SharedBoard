# CLAUDE.md — CoBoard Engineering Guide

> Operating manual for anyone — human or AI agent — working in this repository.
>
> This document tells you **how to work here**. [`RULES.md`](./RULES.md) tells you **what you must not do**. When this file explains a constraint, it cites the rule ID so you can read the binding version.

| Field      | Value                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product    | **CoBoard** — real-time collaborative whiteboard                                                                                                                    |
| Repository | `MuhammadHammad9/SharedBoard`                                                                                                                                       |
| Status     | Phase 9 of 15 complete — M1, M2 and M3 done. Two windows sync live and converge. Presence is Phase 10. See `docs/04-IMPLEMENTATION-PLAN.md` |
| Stack      | React 18.3 · TypeScript 5.4 strict · Vite 6 (defect `D-4`) · Zustand 4 · Canvas 2D · Tailwind 3.x · Node 20 · Express 4 · `ws` · PostgreSQL 15 · Prisma 5 · Redis 7 |

---

# 1. Project orientation

## 1.1 What CoBoard is

A browser-based collaborative whiteboard. Several people open the same board URL and simultaneously draw freehand strokes, place shapes, write text, drop sticky notes and move things around. Every action appears on every other screen within a few hundred milliseconds. Users see each other's cursors move live, labelled with names.

A shared sheet of infinite paper that several people scribble on at once from different cities.

## 1.2 Why it exists

This project demonstrates two genuinely hard problems in frontend engineering:

1. **Real-time synchronization.** Multiple writers mutating shared state concurrently over an unreliable network, with no ordering guarantees, where every client must converge on an identical final state.
2. **Complex, high-frequency UI state.** Selection, tool, viewport, drag, undo and remote-user state all changing tens of times per second, at 60 fps.

A CRUD app proves neither. Everything in this repository serves those two goals.

## 1.3 What success looks like

A person who has never seen the app can open a link, type a name, be drawing within **10 seconds**, see a friend's cursor and strokes live, refresh and find everything intact, lose wifi for 20 seconds and have their offline drawings merge without loss.

## 1.4 The four-document map

| Document                                                             | Answers                                                    | Read it when                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`docs/01-PRD.md`](./docs/01-PRD.md)                                 | **What** to build, and for whom                            | You need a requirement ID, a copy string, a budget, or an acceptance criterion    |
| [`docs/02-FLOWS.md`](./docs/02-FLOWS.md)                             | **Where the user ends up** when they do X on screen A      | You are building a screen, a route guard, a state machine, or an edge case        |
| [`docs/03-TRD.md`](./docs/03-TRD.md)                                 | **How** to build it                                        | You need a schema, a protocol message, an algorithm, or a technical decision      |
| [`docs/04-IMPLEMENTATION-PLAN.md`](./docs/04-IMPLEMENTATION-PLAN.md) | **In what order**, and what "done" means for each step     | You are starting a phase, or you want to know which requirement IDs a task covers |
| [`RULES.md`](./RULES.md)                                             | **What is forbidden**, and which authority wins a conflict | Always. Especially before adding a dependency or a design decision                |

**Read them in this order on day one:** PRD top to bottom → this file → RULES.md §2 → the implementation plan phase you are starting. Then keep the PRD and the plan open in tabs.

## 1.5 The rule about ambiguity

From PRD §0, and it is the most important process rule in the project:

> If a requirement is ambiguous to you, **it is ambiguous, full stop** — do not guess. Post the requirement ID and ask. Ambiguity silently resolved by a guess is the single largest source of rework on projects like this.

See anti-pattern `A-80`.

---

# 2. The ten non-negotiables

Read these before writing anything. Each links its binding rule.

| #   | Rule                                             | Why                                                                                         | Rule ID        |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------- |
| 1   | **Canvas objects never go in React state**       | 60 re-renders/second. This is the single most common way this project dies                  | `R-ARCH-003`   |
| 2   | **Never store screen coordinates**               | If a stored coordinate changes when the user pans, that is data corruption                  | `R-COORD-002`  |
| 3   | **Ops and presence are different things**        | Ops are persisted and acknowledged. Presence is never written to the database               | `R-SYNC-001`   |
| 4   | **The server is the sole authority on ordering** | Every "which change won?" is answered by a server sequence number, never a client timestamp | `R-ARCH-008`   |
| 5   | **Remote ops never touch your undo stack**       | Otherwise undo reverts a teammate's work. Unacceptable                                      | `R-UNDO-001`   |
| 6   | **Persist before ack**                           | An acknowledged op must be durable, or the zero-loss guarantee is a lie                     | `R-SYNC-012`   |
| 7   | **Authorize every socket message server-side**   | A viewer with the console open will try to forge an op                                      | `R-SEC-001`    |
| 8   | **Exactly one `requestAnimationFrame` loop**     | Not one per layer, not one per component                                                    | `R-CANVAS-010` |
| 9   | **A remote cursor must never redraw layer 1**    | If moving a mouse in one window drops the frame rate in another, the layering is wrong      | `R-CANVAS-002` |
| 10  | **Specifications outrank design skills**         | The precedence ladder is not negotiable in a PR thread                                      | `R-PREC-001`   |

---

# 3. Architecture

## 3.1 The three-layer client split

The client has three layers with strict responsibilities. Mixing them is how performance dies.

```
┌─────────────────────────────────────────────────────────────┐
│                       BROWSER (React)                       │
│                                                             │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  UI Layer     │  │ Canvas       │  │  Sync Engine     │  │
│  │  (React)      │  │ Renderer     │  │  (plain TS)      │  │
│  │  header,      │  │ (imperative, │  │  socket client,  │  │
│  │  toolbar,     │  │  rAF loop,   │  │  outbox,         │  │
│  │  panels,      │  │  NOT React)  │  │  seq tracking,   │  │
│  │  modals       │  │              │  │  reconnection    │  │
│  └───────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│          │                 │                   │            │
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

| Layer      | Technology                         | Owns                                           | Re-renders React?                                            |
| ---------- | ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| **UI**     | React components                   | Header, toolbar, panels, modals, toasts        | Only on UI-relevant state                                    |
| **Render** | Plain TS + `requestAnimationFrame` | Drawing pixels                                 | **Never** — reads the store directly via `store.subscribe()` |
| **Sync**   | Plain TS classes                   | Socket, outbox, sequence numbers, reconnection | Only connection status                                       |

### The selector rule

```ts
// GOOD — React re-renders only when the tool changes
const tool = useBoardStore(s => s.activeTool)

// CATASTROPHIC — re-renders on every object mutation, 60 times a second
const objects = useBoardStore(s => s.objects)
```

When a component genuinely needs object data — the properties panel, for instance — select **derived, minimal** data:

```ts
const fill = useBoardStore(s =>
  s.selection.length === 1 ? s.objects.get(s.selection[0])?.style.fill : undefined,
)
```

Rules: `R-ARCH-001` … `R-ARCH-004`.

## 3.2 One stroke, end to end

This trace is the whole system in miniature. If you understand it, you understand CoBoard.

```
 1. pointerdown on the canvas
      → interaction machine: IDLE → DRAWING                    [R-CANVAS-050]
      → canvas.setPointerCapture(e.pointerId)                  [R-CANVAS-054]
      → opId = uuid()  (this is the idempotency key)           [R-SYNC-014]
      → draft stroke created with the first point, in CANVAS coords
      → rendered on the INTERACTION layer (2), not the object layer

 2. pointermove — fires up to 240 Hz on high-refresh devices
      → screenToCanvas(point, viewport)                        [R-COORD-004]
      → append x, y, pressure to the flat number[]             [R-CANVAS-030]
      → renderer.markDirty('interaction')  — handler does NOT draw
                                                               [R-CANVAS-011]
      → throttled to 20 Hz: send { t:'stroke', id, pts: DELTA, done:false }
        This is PRESENCE. Not persisted, not acked, dropped if offline
                                                     [R-SYNC-005, R-SYNC-041]

 3. pointerup
      → releasePointerCapture                                  [R-CANVAS-053]
      → Ramer–Douglas–Peucker simplification, epsilon = 0.5 canvas units
        ONCE, here. Never during the stroke                    [R-CANVAS-032]
        ~400 raw points become ~60 with no visible difference
      → move the object from layer 2 to layer 1; add to the object Map
      → push ONE history entry { forward:[CREATE], inverse:[DELETE] }
                                                   [R-UNDO-004, R-UNDO-010]
      → emit { t:'op', op:{ id, type:'CREATE', objectId, payload } }
      → add to the outbox
      → clear the presence stroke

 4. SERVER — handleOp, in this exact order                        [TRD §5.4]
      1. AUTHORIZE   role must be OWNER or EDITOR, else nack     [R-SEC-001]
      2. VALIDATE    Zod schema; reject, never coerce            [R-SEC-003]
      3. RATE LIMIT  token bucket in Redis, 100 ops/sec/session  [R-SEC-013]
      4. IDEMPOTENCY op.id already stored? re-ack, do not duplicate
                                                                 [R-SYNC-014]
      5. PERSIST     transaction: board.currentSeq increment, then insert.
                     NEVER SELECT MAX(seq) outside a transaction [R-SYNC-013]
      6. ACK SENDER  first — they are waiting to clear the outbox
                                                                 [R-SYNC-015]
      7. BROADCAST   to the rest of the room, batched on a 16 ms timer,
                     and via Redis pub/sub to other instances    [R-SYNC-017]

 5. CLIENT (sender) receives ack
      → remove the op from the outbox
      → store the assigned seq on the local object

 6. CLIENT (others) receive op_batch
      → applyRemoteOp — a DIFFERENT code path from applyAndEmit.
        It does not touch history. This is what keeps undo per-user
                                                                 [R-UNDO-001]
      → ops applied in seq order only; gaps buffered and drained
                                                     [R-SYNC-020, R-SYNC-022]
      → renderer.markDirty('objects')

 6b. If the server NACKs instead
      → remove the object locally, remove its undo entry
      → toast: "That change couldn't be saved."
      → do NOT retry. A nack is a decision, not a network error  [R-SYNC-011]
```

## 3.3 Server layout

REST handles auth, board CRUD, snapshots, members, sharing and upload presigning. The WebSocket gateway handles ops and presence. Both funnel into the same domain services, so an authorization rule cannot be enforced on one path and forgotten on the other.

For v1 a single Node instance is acceptable. Write the Redis pub/sub fan-out path anyway so horizontal scaling is a configuration change rather than a rewrite (TRD §15.2).

---

# 4. Repository layout

```
apps/web/src/
├── main.tsx
├── App.tsx                          # router + providers
├── routes/
│   ├── guards.tsx                   # requireAuth, requireBoardAccess
│   ├── Landing.tsx                  # S-01  — MARKETING zone
│   ├── Login.tsx  Signup.tsx  ForgotPassword.tsx  ResetPassword.tsx
│   ├── OAuthCallback.tsx            # S-02..S-06 — AUTH zone
│   ├── Dashboard.tsx  Trash.tsx  Settings.tsx   # S-07/08/16 — PRODUCT CHROME
│   ├── GuestEntry.tsx               # S-11 — GUEST zone
│   └── Board.tsx                    # S-10 shell — BOARD CHROME
├── features/
│   ├── auth/         hooks, api, forms
│   ├── boards/       BoardCard, BoardGrid, useBoards, api
│   ├── canvas/                      # ◄── CANVAS zone: no design skills
│   │   ├── Canvas.tsx               # mounts the 4 layers, wires events
│   │   ├── renderer/
│   │   │   ├── Renderer.ts          # THE single rAF loop
│   │   │   ├── drawObjects.ts  drawInteraction.ts  drawOverlay.ts
│   │   │   └── shapes/              stroke.ts rect.ts ellipse.ts …
│   │   ├── interaction/
│   │   │   ├── machine.ts           # the FLOWS §15.1 state machine
│   │   │   ├── usePointer.ts  useKeyboard.ts  useWheel.ts
│   │   │   └── handlers/            draw.ts select.ts drag.ts resize.ts rotate.ts
│   │   ├── geometry/                hitTest.ts bounds.ts transform.ts simplify.ts
│   │   └── history/                 HistoryManager.ts inverseOps.ts
│   ├── sync/
│   │   ├── SocketClient.ts          # connect, heartbeat, backoff
│   │   ├── SyncEngine.ts            # ordering, gap fill, apply
│   │   ├── Outbox.ts                # queue, persist, flush
│   │   └── protocol.ts              # re-exported from shared
│   ├── presence/     usePresence.ts  CursorLayer.ts  AvatarStack.tsx
│   └── sharing/      ShareModal.tsx  useMembers.ts
├── components/       ui/ (Button, Modal, Toast, Input, Dropdown, Tooltip…)
├── stores/           boardStore.ts  authStore.ts  uiStore.ts
├── lib/              api.ts  cn.ts  throttle.ts  colours.ts  strings.ts
└── types/            branded.ts

packages/shared/src/
├── schemas/          object.ts  op.ts  board.ts  auth.ts   # Zod
├── protocol.ts                                             # socket messages
├── geometry.ts                                             # pure helpers
└── constants.ts                                            # palettes, limits

apps/server/src/
├── index.ts
├── http/
│   ├── app.ts
│   ├── routes/       auth.ts boards.ts members.ts share.ts uploads.ts
│   └── middleware/   auth.ts rateLimit.ts errorHandler.ts validate.ts
├── ws/
│   ├── gateway.ts    # upgrade handling, auth, socket lifecycle
│   ├── RoomManager.ts  Session.ts
│   └── handlers/     op.ts presence.ts join.ts
├── services/         AuthService.ts BoardService.ts OpService.ts
│                     PermissionService.ts SnapshotService.ts PresenceService.ts
├── db/               prisma client, migrations
└── lib/              redis.ts s3.ts logger.ts jwt.ts
```

## 4.1 Module ownership

Four boundaries chosen so people rarely edit the same file — the practical answer to PRD risk `R-9`. Editing a module you do not own needs a heads-up in the PR description (`R-ARCH-006`).

| Module                              | Owner             |
| ----------------------------------- | ----------------- |
| `features/canvas/renderer`          | Renderer owner    |
| `features/canvas/interaction`       | Interaction owner |
| `features/sync`                     | Sync owner        |
| `features/boards` + `features/auth` | Product owner     |

## 4.2 `packages/shared` is not optional

Zod schemas, TypeScript types, the socket contract and pure geometry helpers live there and are imported by **both** client and server. Duplicating a type across the boundary is how you end up with `strokeWidth` on one side and `stroke_width` on the other, and lose a day to it (`R-ARCH-007`).

---

# 5. Commands

```bash
# Bootstrap
git clone <repo> && cd SharedBoard
cp .env.example .env
docker compose up -d            # postgres + redis
pnpm install
pnpm db:migrate
pnpm db:seed                    # includes the 10,000-object stress board

# Develop
pnpm dev                        # web :5173, server :3000
pnpm dev:web
pnpm dev:server

# Quality gates — all of these block CI
pnpm typecheck                  # tsc --noEmit
pnpm lint                       # eslint, zero warnings tolerated
pnpm test                       # vitest unit + integration
pnpm test:e2e                   # playwright
pnpm audit                      # blocks on high/critical
pnpm analyze                    # bundle visualizer + size budget check

# Database
pnpm db:migrate
pnpm db:studio
pnpm db:reset
```

## 5.1 The debug panel

Append `?debug=1` to any board URL. It shows `lastAppliedSeq`, `objects.size` and a stable **state hash** (all objects sorted by id, floats rounded to 2 dp).

**Two clients on the same board with the same `lastAppliedSeq` must show the same hash.** This is the fastest divergence check that exists. It ships in Phase 11, not in the polish phase (`R-CONV-011`).

## 5.2 The stress board

`pnpm db:seed` creates a board with 10,000 objects. Use it for every performance claim. "It feels fast" on an empty board is not evidence (`R-PERF-025`).

---

# 6. Conventions

## 6.1 TypeScript

- `strict: true`. No `any` without a comment explaining why (`R-GIT-008` item 7).
- **Branded coordinate types are mandatory** (`R-COORD-001`):

  ```ts
  type CanvasPoint = { x: number; y: number; __brand: 'canvas' }
  type ScreenPoint = { x: number; y: number; __brand: 'screen' }
  ```

  This feels pedantic in week 1 and saves a full day in week 5. PRD risk `R-7` is this exact bug.

- Validate at the boundary with Zod, from `packages/shared/src/schemas`. Reject, never coerce (`R-SEC-003`).

## 6.2 Naming

The PRD standardizes vocabulary and so does the code. Use these words to mean exactly these things:

| Term                   | Meaning                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| **Board**              | One infinite canvas with an ID and URL                                 |
| **Object**             | Anything on the board. Not "shape", not "element" — `object`           |
| **Operation / op**     | An atomic immutable change: create, update, delete                     |
| **Op log**             | The append-only ordered list. The source of truth                      |
| **Snapshot**           | Materialized state at a sequence number, so we don't replay 50,000 ops |
| **Session**            | One user's connection to one board                                     |
| **Presence**           | Ephemeral live data — cursor, selection, viewport. Never persisted     |
| **Viewport**           | Visible rectangle: pan `(x, y)` + `zoom`                               |
| **Canvas coordinates** | The board's own infinite space. Objects are always stored in these     |
| **Screen coordinates** | Pixels in the window. **Never stored**                                 |
| **Room**               | Server-side grouping of sessions on one board                          |

## 6.3 Git

- Branches `feat/…` `fix/…` `chore/…` `docs/…` (`R-GIT-001`)
- Conventional Commits: `feat(canvas): add rotation handle` (`R-GIT-002`)
- **~400 changed lines per PR.** A 2,000-line PR will not be reviewed properly and everyone knows it (`R-GIT-003`)
- Every PR states the requirement IDs it implements, includes a screenshot or clip for UI work, gives test evidence, and notes performance impact (`R-GIT-004`)

---

# 7. The design-token contract

**PRD §15 is the single source of truth for design tokens.** Not a starting point, not a suggestion — the contract (`R-UI-001`, conflict `C-7`).

## 7.1 Tokens

| Token                               | Value                                                   | Use                               |
| ----------------------------------- | ------------------------------------------------------- | --------------------------------- |
| `--color-bg-canvas`                 | `#FAFAFA`                                               | Canvas background                 |
| `--color-bg-app`                    | `#FFFFFF`                                               | Panels, header                    |
| `--color-bg-subtle`                 | `#F4F4F5`                                               | Dashboard background              |
| `--color-border`                    | `#E4E4E7`                                               | Dividers, panel edges             |
| `--color-text-primary`              | `#18181B`                                               | Body text                         |
| `--color-text-secondary`            | `#71717A`                                               | Metadata, hints                   |
| `--color-accent`                    | `#4F46E5`                                               | Primary buttons, active tool      |
| `--color-danger`                    | `#DC2626`                                               | Delete, errors                    |
| `--color-success`                   | `#16A34A`                                               | Connected, confirmations          |
| `--color-warning`                   | `#D97706`                                               | Reconnecting                      |
| `--radius-sm` / `md` / `lg`         | 4 / 8 / 12 px                                           | Controls / panels / modals        |
| `--shadow-panel`                    | `0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06)` | Floating panels                   |
| `--space-*`                         | 4, 8, 12, 16, 24, 32, 48 px                             | 4 px base scale — never arbitrary |
| `--font-sans`                       | `Inter, system-ui, -apple-system, sans-serif`           | All UI                            |
| `--duration-fast` / `base` / `slow` | 120 / 200 / 320 ms                                      | Micro / standard / modal          |
| `--easing-standard`                 | `cubic-bezier(0.2, 0, 0, 1)`                            | Default easing                    |

## 7.2 Frozen palettes

These two are **frozen** and carry protocol meaning. They are not styling choices.

**Presence palette** — 12 colours, assigned round-robin per room, server-side. A user's colour must render identically for every participant, so it cannot be themed (`R-UI-013`):

```
#EF4444  #F97316  #EAB308  #84CC16  #22C55E  #14B8A6
#06B6D4  #3B82F6  #6366F1  #A855F7  #EC4899  #F43F5E
```

**Sticky note palette** — 8 colours. A sticky's colour is a persisted object property, so changing these changes stored data (`R-UI-014`):

```
#FEF08A yellow   #FED7AA orange   #FBCFE8 pink    #FECACA red
#E9D5FF purple   #BFDBFE blue     #BBF7D0 green   #E4E4E7 grey
```

## 7.3 Tailwind mapping

Tailwind **3.x**, not v4 (`R-PREC-017`, conflict `C-8`). Tokens map through `theme.extend`:

```ts
// tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        canvas: '#FAFAFA',
        app: '#FFFFFF',
        subtle: '#F4F4F5',
        border: '#E4E4E7',
        primary: '#18181B',
        muted: '#71717A',
        accent: '#4F46E5',
        danger: '#DC2626',
        success: '#16A34A',
        warning: '#D97706',
        presence: {/* the 12 frozen colours */},
        sticky: {/* the 8 frozen colours */},
      },
      borderRadius: { sm: '4px', md: '8px', lg: '12px' },
      spacing: {
        1: '4px',
        2: '8px',
        3: '12px',
        4: '16px',
        6: '24px',
        8: '32px',
        12: '48px',
      },
      fontFamily: { sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'] },
      boxShadow: { panel: '0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06)' },
      transitionDuration: { fast: '120ms', base: '200ms', slow: '320ms' },
      transitionTimingFunction: { standard: 'cubic-bezier(0.2, 0, 0, 1)' },
    },
  },
}
```

Use theme colours directly (`bg-accent`), not `var()` wrappers (`R-UI-004`). Never an arbitrary colour value (`R-UI-002`).

---

# 8. Skill playbooks

Six design and motion skills are available. They are **Tier 4** authority — they inform craft, they never override a specification (`R-SKILL-001`). Before invoking any of them, determine your **zone** (§9).

`RULES.md` §2.3 records the eight conflicts (`C-1`…`C-8`) between these skills and the specifications, with the losing side named in each. Read it once before your first UI task.

---

## 8.1 `ui-ux-pro-max`

**What it is.** A searchable design-intelligence database — 67 styles, 96 colour palettes, 57 font pairings, 99 UX guidelines, 25 chart types, across 13 stacks. Backed by Python scripts over CSV data.

**When to invoke.** Any zone except Canvas. It is the most broadly useful of the six because most of its value is UX and accessibility guidance rather than aesthetics.

**When not to.** Never for the canvas layers (`R-SKILL-011`). Never to pick colours or fonts — see the override below.

**Invocation.** Use the **absolute path**. The skill's own documentation gives a relative `skills/…` path that does not resolve from the repository root (`R-SKILL-021`):

```bash
S=/root/.claude/skills/synced/ui-ux-pro-max/scripts/search.py

# Domain search — the mode you will use most
python3 $S "modal focus trap" --domain ux -n 5
python3 $S "virtualize long list" --domain web -n 5
python3 $S "rerender memo" --domain react -n 5

# Stack guidance
python3 $S "state performance" --stack react

# Full design system (advisory only — see override)
python3 $S "collaborative whiteboard saas" --design-system -f markdown
```

**Domains** (verified against `--help`, not the skill's own docs, which are out of date here):
`style` `color` `chart` `landing` `product` `ux` `typography` `icons` `react` `web`

**Stacks:**
`html-tailwind` `react` `nextjs` `astro` `vue` `nuxtjs` `nuxt-ui` `svelte` `swiftui` `react-native` `flutter` `shadcn` `jetpack-compose`

**Other flags:** `--design-system`, `--persist`, `--page`, `--output-dir`, `-n/--max-results` (default 3), `-p/--project-name`, `-f/--format {ascii,markdown}`, `--json`.

> The skill's own `SKILL.md` lists a `prompt` domain that the CLI does not accept, and omits `icons`, `astro`, `nuxtjs` and `nuxt-ui`. The lists above come from `search.py --help`. Run `--help` before relying on a flag you have not used before.

**Overridden here.** Its **colour and typography output is advisory only** (`R-SKILL-020`, conflict `C-7`). Its icon recommendation of Lucide loses to Phosphor (`C-2`).

**Do not run `--persist`** (`R-SKILL-022`). It writes a `design-system/MASTER.md` whose palette and typography would contradict PRD §15, creating a second and wrong source of truth. §7 of this file is the master.

**Worked example.** Running the generator against this product actually returns:

```
Primary #0D9488 (teal) · Secondary #14B8A6 · CTA #F97316 (orange)
Background #F0FDFA · Text #134E4A · Typography: Plus Jakarta Sans
Pattern: Interactive Demo + Feature-Rich · Style: Flat Design
```

PRD §15 mandates `#4F46E5` indigo, `#FAFAFA`, `#18181B` and Inter. **Take the pattern, style keywords, effects guidance, anti-patterns and the pre-delivery checklist. Discard the palette and the font.** That is the precedence ladder working exactly as intended.

**Adopted in full.** Its pre-delivery checklist is `R-UI-040`, and its "common rules for professional UI" — no emoji as icons, stable hover states, `cursor-pointer` on clickables, consistent icon sizing, light-mode contrast floors, floating-navbar spacing — are rules `R-UI-011` … `R-UI-044`.

---

## 8.2 `design-taste-frontend`

**What it is.** An anti-slop skill that reads the brief, infers a design direction, and avoids templated output. Its own header scopes it: _"Landing pages, portfolios, and redesigns. Not dashboards, not data tables, not multi-step product UI."_

**When to invoke.** Marketing (S-01) in full. Auth zone for typography and colour guidance only.

**When not to.** Product chrome, board chrome, canvas. It excludes itself from those by its own terms (conflict `C-5`).

**Mandatory pre-flight.** State a one-line **Design Read** before generating (`R-SKILL-030`):

> _"Reading this as: product-led SaaS landing for design-conscious collaborators, with a Linear-clean language, leaning toward Tailwind utilities + Inter + restrained motion."_

**The three dials, locked per zone** (`R-SKILL-031`). Do not re-derive these per task:

| Zone             | `DESIGN_VARIANCE` | `MOTION_INTENSITY` | `VISUAL_DENSITY` |
| ---------------- | ----------------- | ------------------ | ---------------- |
| Marketing (S-01) | 7                 | 6                  | 4                |
| Auth             | 5                 | 3                  | 4                |
| Product chrome   | 5                 | 3                  | 5                |
| Board chrome     | 4                 | 2                  | 6                |
| System states    | 4                 | 2                  | 3                |

Board chrome sits lowest on motion because of conflict `C-6`.

**Adopted.** §3.C icons (Phosphor first — this is where `C-2` resolves), §3.E layout mechanics (`min-h-[100dvh]` never `h-screen`; CSS Grid never flex percentage arithmetic), §4 bias corrections, §9 AI-tells, §14 pre-flight check.

**Void here.** §3.A Tailwind v4 guidance (`C-8` — we are on 3.x, and its PostCSS instructions do not apply). Its font guidance (`C-1` — Inter is mandated). Any application to board or canvas layout (`C-5`).

**Its §9.D "Jane Doe effect" applies to seed data** (`R-UI-060`). Use realistic board and member names, not `Test Board 1`.

---

## 8.3 `high-end-visual-design`

**What it is.** Agency-tier visual direction — a Variance Engine that picks a vibe and layout archetype, nested "Double-Bezel" container architecture, macro-whitespace, and spring-physics motion.

**When to invoke.** Marketing (S-01) and the S-11 guest join card only (`R-SKILL-040`).

**When not to.** Everywhere else. Its aesthetic vocabulary — heavy `backdrop-blur`, deep OLED backgrounds, 800 ms blur-fades, rotated overlapping cards — is wrong for a productivity tool and breaks the 60 fps canvas budget (`C-6`).

**Adopted.**

- **Variance Engine** — pick one vibe archetype and one layout archetype so output is not identical every time.
- **Double-Bezel** — outer shell with a hairline border and small padding, inner core with its own background and a mathematically concentric smaller radius. Premium cards look like machined hardware rather than flat rectangles.
- **Button-in-button trailing icon** — an arrow in a CTA sits inside its own circular wrapper, flush with the button's inner padding, never naked beside the text.
- **Macro-whitespace** — `py-24` to `py-40` on marketing sections.
- **Eyebrow tags** — a microscopic pill badge above major headings.
- **§6 Performance Guardrails**, promoted to **global** rules because they agree with the PRD (`R-SKILL-042`): animate only `transform` and `opacity`; `backdrop-blur` on fixed/sticky elements only; grain overlays only on fixed `pointer-events-none` pseudo-elements; no arbitrary z-index.

**Overridden here.** Its font ban (`C-1` — Inter stays) and its icon ban (`C-2` — Phosphor Light satisfies its "ultra-light, precise lines" requirement anyway).

---

## 8.4 `gpt-taste`

**What it is.** Awwwards-level landing-page engineering — seeded randomization to break layout repetition, AIDA page structure, wide editorial typography, gapless bento grids, and GSAP scroll choreography.

**When to invoke.** **S-01 only** (`R-SKILL-050`). It is entirely landing-page grammar.

**Mandatory pre-flight.** Produce its `<design_plan>` block before writing S-01 markup (`R-SKILL-051`): the seeded selection, the AIDA check, hero math verification naming the `max-w` class, bento density proof, and the label/button sweep.

**Adopted.**

- **AIDA structure** — Attention (hero), Interest (features/bento), Desire (scroll/media), Action (CTA/footer).
- **The 2-to-3-line H1 iron rule** — ultra-wide containers (`max-w-5xl`/`max-w-6xl`), `clamp(3rem, 5vw, 5.5rem)`. A 6-line wrapped heading is a failure.
- **Gapless bento** — `grid-flow-dense`, mathematically interlocking spans, no dead cells. 3–5 intentional cards, not 8 messy ones.
- **The meta-label ban** — no "SECTION 01", no "QUESTION 05". Delete them.
- **Button contrast verification** — dark background gets white text, light gets dark. Invisible button text is a failure.
- **`overflow-x-hidden` page wrapper** to prevent horizontal scrollbars from off-screen animation.

**Not adopted: its GSAP mandate** (`R-SKILL-052`, conflict `C-3`). GSAP + ScrollTrigger is roughly 50 KB against a 250 KB initial budget, for one page. Reproduce its paradigms without it:

| `gpt-taste` paradigm           | CoBoard implementation                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| ScrollTrigger pinning          | `position: sticky` + `IntersectionObserver`                                                 |
| Scrubbing text reveal          | CSS scroll-driven animation (`animation-timeline: view()`), `IntersectionObserver` fallback |
| Image scale and fade on scroll | `IntersectionObserver` toggling a class; `transform`/`opacity` transition                   |
| Card stacking                  | `position: sticky` with incremental `top` offsets                                           |

Its `picsum.photos` guidance is for development placeholders only (`R-SKILL-054`).

---

## 8.5 `framer-motion-animator`

**What it is.** Framer Motion (now `motion/react`) patterns — variants, `AnimatePresence`, stagger, gestures, scroll hooks, shared layout transitions.

**When to invoke.** Marketing and product-chrome (dashboard) zones only, lazy-loaded (`R-SKILL-060`, `R-SKILL-061`).

**When not to.** **The board route.** Framer Motion is banned there — it costs ~40 KB against a 200 KB board chunk budget, and its `requestAnimationFrame`-driven animation competes with the render loop for exactly the main thread the canvas needs (conflicts `C-3`, `C-4`). Enforced by an automated import check (`R-PERF-021`).

**Adopted patterns.** Variants with `staggerChildren`, `AnimatePresence` for exit animations, `layoutId` for shared-element transitions, `useMotionValue`/`useTransform`/`useScroll` for continuous values, and the transition presets:

```ts
export const transitions = {
  spring: { type: 'spring', stiffness: 300, damping: 24 },
  springBouncy: { type: 'spring', stiffness: 500, damping: 15 },
  springStiff: { type: 'spring', stiffness: 700, damping: 30 },
  smooth: { type: 'tween', duration: 0.3, ease: 'easeInOut' },
  snappy: { type: 'tween', duration: 0.15, ease: [0.25, 0.1, 0.25, 1] },
} as const
```

**Two mandatory caveats.**

1. **Use full `transform` strings, not `x`/`y` shorthand** (`R-SKILL-062`). Per `emil-design-eng`, the shorthand props are not hardware-accelerated — they run `requestAnimationFrame` on the main thread and drop frames when the browser is busy:

   ```tsx
   <motion.div animate={{ x: 100 }} />                         // drops frames under load
   <motion.div animate={{ transform: "translateX(100px)" }} /> // hardware accelerated
   ```

2. **Never drive continuous pointer or scroll values through `useState`** (`R-SKILL-064`). It re-renders the tree on every change and collapses on mobile. Use motion values.

`useReducedMotion` is mandatory in every animated component (`R-A11Y-010`).

---

## 8.6 `emil-design-eng`

**What it is.** Emil Kowalski's design-engineering philosophy — the invisible details that make software feel right.

**When to invoke.** **Everywhere.** This is the default motion authority for the whole application (`R-SKILL-070`, conflict `C-6`), including zones where no other skill applies. It is the only motion skill whose philosophy agrees with the PRD's performance requirements.

**Operational note.** Invoked with no specific question, this skill replies with a single fixed line and nothing else. **Always invoke it with a concrete question** (`R-SKILL-071`):

> _"Review the toast enter and exit transitions in `components/ui/Toast.tsx`."_

**The decision framework — answer in order before writing any animation.**

**1. Should this animate at all?** (`R-MOTION-001`)

| Frequency                                                               | Decision                     |
| ----------------------------------------------------------------------- | ---------------------------- |
| 100+ times/day — keyboard shortcuts, tool switching, selection, drawing | **No animation. Ever.**      |
| Tens of times/day — hover, list navigation                              | Remove or drastically reduce |
| Occasional — modals, drawers, toasts                                    | Standard animation           |
| Rare — onboarding, celebrations                                         | May add delight              |

This table is why the canvas is a no-decoration zone. A whiteboard's core interactions land squarely in the top row.

**2. What is the purpose?** Valid answers: spatial consistency, state indication, explanation, feedback, preventing a jarring change. "It looks cool" is not a purpose for anything seen often.

**3. What easing?** (`R-MOTION-011`) Entering or exiting → `ease-out`. Moving or morphing → `ease-in-out`. Hover or colour → `ease`. Constant motion → `linear`. **Never `ease-in` for UI** — it delays the exact moment the user is watching most closely (`R-MOTION-010`).

Built-in CSS easings are too weak. Project curves (`R-MOTION-012`):

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1); /* UI interactions */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1); /* on-screen movement */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1); /* iOS-like drawer */
--easing-standard: cubic-bezier(0.2, 0, 0, 1); /* PRD §15 default */
```

**4. How fast?** (`R-MOTION-020`) Button press 100–160 ms · tooltips 125–200 ms · dropdowns 150–250 ms · modals and drawers 200–500 ms. **UI animations stay under 300 ms.**

**Component principles, all adopted as rules in `RULES.md` §13.4:**

- `transform: scale(0.97)` on `:active` for anything pressable. Instant feedback that the interface heard you.
- **Never animate from `scale(0)`.** Nothing in the real world appears from nothing. Start at `scale(0.95)` with `opacity: 0`.
- **Popovers and tooltips are origin-aware** — they scale from their trigger. **Modals are exempt** and stay centred, because they are not anchored to a trigger.
- Tooltips delay before the first appearance, then open instantly with no animation for adjacent triggers.
- **CSS transitions, not keyframes**, for anything rapidly triggered. Transitions retarget mid-flight; keyframes restart from zero.
- `@starting-style` for entry animation where support allows.
- `filter: blur(2px)` to mask an imperfect crossfade. Keep blur under 20 px — expensive, especially in Safari.
- `clip-path: inset(…)` for reveals, hold-to-delete, tab colour transitions and comparison sliders.
- Percentage translations over hardcoded pixels.
- Stagger 30–80 ms between items; never block interaction on it.
- Asymmetric timing — slow where the user is deciding, fast where the system is responding.

**Performance rules, promoted to global:** animate only `transform` and `opacity`; never `transition: all`; do not update inheritable CSS variables on a parent during a drag (it recalculates styles for every child — set `transform` on the element directly); CSS animations beat JS under load because they run off the main thread; WAAPI when you need JS control with CSS performance.

**Accessibility:** `prefers-reduced-motion` means fewer and gentler animations, not zero — keep opacity and colour transitions that aid comprehension, remove movement. Gate hover animations behind `@media (hover: hover) and (pointer: fine)` (`R-MOTION-061`).

**Review format is mandatory** (`R-SKILL-072`). A single markdown table, one row per issue:

| Before                  | After                                  | Why                                                         |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `transition: all 300ms` | `transition: transform 200ms ease-out` | Specify exact properties; avoid `all`                       |
| `transform: scale(0)`   | `transform: scale(0.95); opacity: 0`   | Nothing in the real world appears from nothing              |
| `ease-in` on dropdown   | `ease-out` with a custom curve         | `ease-in` feels sluggish at the moment the user is watching |

Not a bulleted list. A table.

---

# 9. Zoning — which skill applies where

Two of the six skills exclude themselves from product UI by their own terms, and CoBoard is roughly 90% product UI. Zoning is how all six stay useful without producing a whiteboard that looks like a marketing site (conflict `C-5`, rule `R-SKILL-010`).

| Zone               | Screens                                      | Skills that fire                                                                                          | Forbidden                                                       |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Marketing**      | S-01                                         | `gpt-taste`, `high-end-visual-design`, `design-taste-frontend`, `ui-ux-pro-max`, `framer-motion-animator` | —                                                               |
| **Auth**           | S-02 … S-06                                  | `ui-ux-pro-max`, `emil-design-eng`, `design-taste-frontend` (type/colour only)                            | `gpt-taste`                                                     |
| **Product chrome** | S-07, S-08, S-09, S-16                       | `ui-ux-pro-max`, `emil-design-eng`, `framer-motion-animator` (lazy)                                       | `gpt-taste`, `high-end-visual-design`                           |
| **Board chrome**   | S-10 header/toolbar/panels/zoom, S-12 … S-15 | `ui-ux-pro-max`, `emil-design-eng`                                                                        | `gpt-taste`, `high-end-visual-design`, `framer-motion-animator` |
| **Canvas**         | The 4 layers                                 | **None** — TRD §7 is the only authority                                                                   | All six                                                         |
| **System states**  | S-17 … S-21                                  | `ui-ux-pro-max`, `emil-design-eng`                                                                        | `gpt-taste`, `high-end-visual-design`                           |
| **Guest**          | S-11, S-22                                   | `ui-ux-pro-max`, `emil-design-eng`, `high-end-visual-design` (join card only)                             | `gpt-taste`                                                     |

Modals belong to the zone of the screen that opens them (`R-SKILL-012`).

## 9.1 Decision tree

```
What am I building?

├─ Pixels on a canvas layer?
│    → NO design skill. TRD §7 only. No animation. No blur. No shadow.
│      [R-SKILL-011, R-MOTION-004]
│
├─ The landing page (S-01)?
│    → gpt-taste <design_plan> → design-taste-frontend Design Read (7/6/4)
│      → high-end-visual-design archetypes → ui-ux-pro-max --domain landing
│      → Framer Motion permitted, lazy. NO GSAP. [R-MOTION-051]
│
├─ An auth form (S-02..S-06)?
│    → ui-ux-pro-max --domain ux  →  emil-design-eng for press/focus states
│      Dials 5/3/4. No hero grammar.
│
├─ Dashboard / trash / settings (S-07/08/09/16)?
│    → ui-ux-pro-max --domain ux + --stack react  →  emil-design-eng
│      Framer Motion permitted, lazy. Skeletons not spinners. [R-UI-051]
│
├─ Board header, toolbar, properties panel, a modal (S-10 chrome, S-12..S-15)?
│    → ui-ux-pro-max  →  emil-design-eng
│      NO Framer Motion — it must not enter the board chunk. [R-SKILL-060]
│      Apply the frequency gate hard: the toolbar is used constantly.
│
└─ An error or empty state (S-17..S-21)?
     → ui-ux-pro-max  →  emil-design-eng
       Copy comes verbatim from strings.ts. [R-UI-052]
```

---

# 10. Motion policy

## 10.1 The gate

Before writing any animation, apply the frequency test (§8.6, `R-MOTION-001`). Most of this application is in the "no animation, ever" band. That is the correct outcome, not a missed opportunity.

## 10.2 The canvas is a no-decoration zone

No entrance animation. No blur. No scroll effect. No shadow. No decorative gradient. On any of the four canvas layers.

The only movement on the canvas is the movement the user is making (`R-MOTION-004`, conflict `C-6`). PRD `G-3` requires ≥55 fps with 5,000 objects and ≤16 ms input-to-pixel latency; there is no budget for decoration, and decoration on a drawing surface reads as lag rather than polish.

## 10.3 Library policy

| Mechanism                                      | Where                                     | Why                                                    |
| ---------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| **CSS transitions + custom cubic-béziers**     | Everywhere, default                       | Zero bundle cost, off main thread, interruptible       |
| **`@starting-style` / WAAPI**                  | Entry animations, programmatic control    | Same benefits, no library                              |
| **`IntersectionObserver` + CSS scroll-driven** | Marketing scroll effects                  | Replaces GSAP ScrollTrigger at zero cost               |
| **Framer Motion**                              | Marketing + dashboard chunks, lazy-loaded | Gesture and shared-layout work that CSS cannot express |
| **GSAP**                                       | **Not a dependency**                      | ~50 KB for one page against a 250 KB budget            |

`R-MOTION-050` … `R-MOTION-053`.

## 10.4 Quick reference

```css
/* Curves */
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
--easing-standard: cubic-bezier(0.2, 0, 0, 1);

/* Durations */
--duration-fast: 120ms; /* micro    — button press, hover */
--duration-base: 200ms; /* standard — dropdown, tooltip   */
--duration-slow: 320ms; /* modal    — dialog, drawer      */
```

Never `ease-in`. Never `transition: all`. Never animate `width`, `height`, `top`, `left`, `margin` or `padding`. Never animate from `scale(0)`.

---

# 11. Performance budgets

Budgets, not aspirations. A PR that regresses one does not merge (`R-PERF-001`).

| Metric                            | Budget        | How to measure                  |
| --------------------------------- | ------------- | ------------------------------- |
| Landing LCP                       | ≤ 1.5 s on 4G | Lighthouse                      |
| Dashboard interactive             | ≤ 2.0 s       | Lighthouse                      |
| Board first paint, 500 objects    | ≤ 1.5 s       | Custom perf mark                |
| Board first paint, 5,000 objects  | ≤ 3.0 s       | Custom perf mark                |
| Drawing frame rate, 5,000 objects | ≥ 55 fps      | Chrome perf panel, stress board |
| Pan/zoom frame rate               | ≥ 55 fps      | Chrome perf panel               |
| Input to local pixel              | ≤ 16 ms       | Instrumented                    |
| Local input to remote render, p95 | ≤ 250 ms      | Instrumented, same region       |
| Initial JS, gzipped               | ≤ 250 KB      | `pnpm analyze` — CI gate        |
| Board route chunk, gzipped        | ≤ 200 KB      | `pnpm analyze` — CI gate        |
| Heap with 5,000 objects           | ≤ 300 MB      | Chrome memory profiler          |
| Typical WebSocket op              | ≤ 2 KB        | Network tab                     |

## 11.1 Where the frames go

Profile before optimizing. At 5,000 objects the typical distribution is:

| Cost                         | Share | Fix                                             |
| ---------------------------- | ----- | ----------------------------------------------- |
| Canvas context state changes | ~40%  | Batch by style                                  |
| Path construction            | ~25%  | Simplify strokes; cull                          |
| React re-renders             | ~20%  | Narrow selectors; keep objects out of React     |
| Hit testing                  | ~10%  | AABB pre-filter; spatial index only if measured |
| Serialization                | ~5%   | Delta presence; batch ops                       |

**Do not build a spatial index preemptively** (`R-CANVAS-029`). A linear filter is fine to ~10,000 objects.

## 11.2 Memory

Every `addEventListener` has a matching remove. `cancelAnimationFrame` on unmount. Image cache LRU-capped at 100. Presence entries deleted on leave and swept after 60 s idle. Tombstones capped at 10,000. History capped at 100. Canvas refs nulled on unmount (`R-PERF-023`).

Test: use a board for 30 minutes, heap snapshot, close and reopen 10 times, force GC, snapshot again. Growth should be near zero.

---

# 12. Security essentials

Full rules in `RULES.md` §11. The ones that catch people out:

- **Authorization is server-side on every socket message and every request.** Client checks are UX only. A viewer with the console open will try `socket.send({t:'op', …})` — test `AT-20` exists precisely to verify the server rejects it (`R-SEC-001`, `R-SEC-002`).
- **Access tokens live in memory only** — a module variable, never `localStorage`, because any XSS can exfiltrate them. Refresh tokens are `httpOnly` so JavaScript cannot read them at all (`R-SEC-005`).
- **Refresh rotation includes reuse detection.** A revoked token being presented means theft: revoke the whole family (`R-SEC-006`).
- **Validate with Zod at the boundary. Reject, never coerce.** Every numeric field needs explicit finite bounds — an `Infinity` in a coordinate propagates through the renderer and blanks the canvas for **every** user in the room (`R-SEC-003`, `R-SEC-004`).
- **Never reveal whether an email is registered** (`R-SEC-008`).
- **Never show the board name on the 403 screen** (`R-SEC-018`).
- **No `dangerouslySetInnerHTML`.** ESLint enforces it (`R-SEC-010`).
- **A secret in a commit means rotating the secret**, not just reverting the commit (`R-SEC-016`).

---

# 13. Testing

| Level       | Tool                 | Target                                           |
| ----------- | -------------------- | ------------------------------------------------ |
| Unit        | Vitest               | 80% of `lib`, `geometry`, `history`, `sync`      |
| Component   | Testing Library      | Forms, modals, board cards, toolbar              |
| Integration | Vitest + supertest   | Every endpoint, including authorization failures |
| Socket      | Vitest + `ws` client | Every message type                               |
| E2E         | Playwright           | Every PRD §11 scenario, multi-context            |

## 13.1 The five tests that matter

Write these first (`R-TEST-002`). They catch real bugs; most others catch typos.

1. **Convergence** — two clients, 200 random concurrent operations, assert matching state hashes. This single test will catch more real bugs than any other in the project.
2. **Offline merge** — both clients draw while one is offline; assert no loss and matching hashes.
3. **Collaborative undo** — A draws, B draws, A undoes. Only A's stroke disappears.
4. **Delete beats update** — concurrent delete and move; the object is gone on both sides.
5. **Server-side permission** — a viewer's forged socket op is nacked and nothing is written.

The chaos scenarios `AT-30` … `AT-35` are ship-blocking (`R-TEST-003`).

## 13.2 Manual QA per release

Two windows side by side for two minutes, compare hashes · DevTools offline, draw 10 strokes, back online · Slow 3G, confirm local drawing stays instant · the 10k stress board while panning · zoom to 10% and 500%, confirm hit testing · full keyboard-only pass on every non-canvas screen · every breakpoint · Safari, Firefox, Chrome stroke rendering · kill and restart the server mid-session · trash a board with three people connected.

---

# 14. Definition of Done

A feature is done when **all eleven** are true. Not most (`R-GIT-008`, PRD §10.1):

1. Implements every acceptance criterion of its requirement ID
2. Handles loading, empty, error and offline states
3. Keyboard accessible with visible focus
4. Works at every breakpoint
5. Unit tests for logic; integration test for the happy path and at least one failure path
6. No new console errors or warnings
7. No TypeScript `any` without a comment explaining why
8. Meets the relevant performance budget
9. Copy matches PRD §8 exactly
10. Reviewed and approved by one other person
11. Server-side authorization enforced where applicable

Item 2 is the one interns skip. PRD risk `R-4` rates it "Very High" likelihood. Reviewers reject PRs without it.

---

# 15. When something is wrong — symptom index

| Symptom                                             | Likely cause                                              | Where to look                                   |
| --------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Drawing lags on a busy board                        | Objects in React state, or layer 1 redrawing too often    | `R-ARCH-003`, `R-CANVAS-002`; TRD §12.1         |
| Moving the mouse in one window drops FPS in another | Cursors rendering on the object layer                     | `R-CANVAS-002`; FLOWS §14.3                     |
| Two clients show different boards                   | Ops applied out of order, or a full-object UPDATE payload | `R-SYNC-020`, `R-CONV-002`; the `?debug=1` hash |
| Undo reverted a teammate's work                     | A remote op reached the history stack                     | `R-UNDO-001`; TRD §8.3                          |
| Objects flicker in then vanish on load              | Snapshot/socket buffering rule not followed               | `R-SYNC-035`; FLOWS §2.3 step 5                 |
| Object jumps when the user pans                     | Screen coordinates were stored                            | `R-COORD-002`                                   |
| Stuck in a drag forever                             | `pointercancel` not handled                               | `R-CANVAS-052`; FLOWS §15.1                     |
| Duplicate objects after reconnect                   | Op IDs not used as idempotency keys                       | `R-SYNC-014`; TRD §5.4 step 4                   |
| Ops lost after a server restart                     | Acking before persisting                                  | `R-SYNC-012`; TRD D-14                          |
| Two ops got the same seq                            | `SELECT MAX(seq)` outside a transaction                   | `R-SYNC-013`; TRD §5.4                          |
| Server hammered after a restart                     | Backoff without full jitter                               | `R-SYNC-030`; TRD §10.2                         |
| A viewer edited the board                           | Client-side-only permission check                         | `R-SEC-001`; test `AT-20`                       |
| Canvas blank for everyone in the room               | `Infinity`/`NaN` coordinate accepted                      | `R-SEC-004`; TRD §11.3                          |
| A flash of the login screen                         | Silent refresh not awaited before routing                 | FLOWS §2.2 step 2                               |
| Bundle over budget                                  | An animation library reached the wrong chunk              | `R-PERF-020`, `R-PERF-021`                      |
| Copy differs between two screens                    | Strings inlined instead of imported                       | `R-UI-052`                                      |
| UI feels sluggish though it is fast                 | `ease-in`, or durations over 300 ms                       | `R-MOTION-010`, `R-MOTION-021`                  |
| Design decision disputed in review                  | Check the precedence ladder before arguing                | `RULES.md` §2                                   |

---

# 16. Document map

```
README.md                        Repo index
CLAUDE.md                        ← you are here. How to work
RULES.md                         What is forbidden. Cite by rule ID
docs/
├── 01-PRD.md                    What to build. Requirement IDs, budgets, copy
├── 02-FLOWS.md                  Screens, routing, state machines, edge cases
├── 03-TRD.md                    Schemas, protocol, algorithms, decisions
└── 04-IMPLEMENTATION-PLAN.md    15 phases, traceability, appendices
```

The three specification documents in `docs/` are preserved **exactly as delivered** and must not be edited. Corrections go in the defect register at `RULES.md` §2.4 (`R-PREC-020`).
