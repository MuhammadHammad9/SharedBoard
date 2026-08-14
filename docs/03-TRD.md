# Technical Requirements Document (TRD)
## Project: **CoBoard** — Real-Time Collaborative Whiteboard

| Field | Value |
|---|---|
| Document type | Technical Requirements / System Design |
| Version | 1.0 |
| Audience | Intern engineering team |
| Companion docs | `01-PRD.md`, `02-FLOWS.md` |

---

# 0. Preface for interns

This document tells you **how** to build what the PRD describes. It contains decisions that have already been made. Where I have written "do not do X", it is because X has been tried and it breaks.

Three principles govern everything here:

1. **The server is the sole authority on ordering.** Clients propose; the server decides. Every ambiguity about "which change won" is answered by a server-assigned sequence number.
2. **The client is optimistic and never blocks on the network.** Drawing must feel instant even at 400 ms round-trip latency.
3. **State is derived, never guessed.** Board state is a pure function of its op log. If you cannot reconstruct the board from the log, you have a bug.

---

# 1. Technology stack

## 1.1 Frontend

| Concern | Choice | Version | Why |
|---|---|---|---|
| Framework | React | 18.3 | Required by the brief. Concurrent features help keep input responsive |
| Language | TypeScript | 5.4+, `strict: true` | Coordinate-space bugs are caught at compile time |
| Build | Vite | 5.x | Fast HMR, good code splitting |
| Routing | React Router | 6.x | Standard, supports the guard patterns in FLOWS §2 |
| Client state | Zustand | 4.x | Minimal boilerplate, selector-based subscriptions, and it can be read outside React (essential — the render loop is not a React component) |
| Server state | TanStack Query | 5.x | Caching, retries, and invalidation for REST endpoints |
| Rendering | Canvas 2D API | native | Required by the brief. WebGL is out of scope |
| Styling | Tailwind CSS | 3.x | Design tokens map cleanly to the theme config |
| Sockets | Native `WebSocket` | native | Explicitly chosen over Socket.IO — see §1.4 |
| Forms | React Hook Form + Zod | latest | Shares schemas with the backend |
| Testing | Vitest, Testing Library, Playwright | latest | Unit, component, e2e |

## 1.2 Backend

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 LTS | Same language as the frontend; shared types |
| HTTP framework | Express 4 | Simple, well-documented |
| WebSocket | `ws` | Thin, fast, no protocol magic |
| Database | PostgreSQL 15 | Relational needs plus `JSONB` for object payloads |
| ORM | Prisma 5 | Type-safe queries, painless migrations |
| Cache / pub-sub | Redis 7 | Presence, rate limits, and cross-instance op fan-out |
| Object storage | S3-compatible | Image uploads |
| Validation | Zod | Shared schemas with the client |
| Auth | Custom JWT + bcrypt | Full control, and it teaches how auth actually works |
| Logging | Pino | Structured JSON logs |

## 1.3 Shared

A `packages/shared` workspace holds Zod schemas, TypeScript types, the socket message contract, and pure geometry helpers. **Both the client and server import from it.** If a type is duplicated in two places, they will drift, and you will spend a day on a bug caused by a field named `strokeWidth` on one side and `stroke_width` on the other.

## 1.4 Why native WebSocket rather than Socket.IO

| Factor | Native WS | Socket.IO |
|---|---|---|
| Bundle size | 0 KB | ~40 KB gzipped |
| Message overhead | Just our frame | Engine.IO framing |
| Reconnection | We write it | Provided |
| Rooms | We write it | Provided |
| Fallbacks | None | Long-polling |
| **Learning value** | **High** | Low |

We are deliberately writing the reconnection and room logic ourselves, because that logic *is* the project. Socket.IO would hide exactly the thing we are trying to demonstrate. Modern browser support for WebSocket is universal, so the polling fallback buys us nothing.

---

# 2. System architecture

## 2.1 High-level diagram

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
│                     │ (objects,    │                        │
│                     │  viewport,   │                        │
│                     │  selection,  │                        │
│                     │  presence)   │                        │
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
│          │                                  │                │
│  ┌───────▼──────────────────────────────────▼─────────────┐  │
│  │                  Domain Services                        │  │
│  │  AuthService · BoardService · OpService ·               │  │
│  │  PresenceService · PermissionService · SnapshotService  │  │
│  └───────┬──────────────────────────────────┬─────────────┘  │
└──────────┼──────────────────────────────────┼───────────────┘
           ▼                                  ▼
   ┌───────────────┐                  ┌───────────────┐
   │  PostgreSQL   │                  │    Redis      │
   │  users,       │                  │  presence,    │
   │  boards,      │                  │  rate limits, │
   │  members,     │                  │  pub/sub for  │
   │  operations,  │                  │  multi-       │
   │  snapshots    │                  │  instance     │
   └───────────────┘                  └───────────────┘
                    ┌───────────────┐
                    │  S3 storage   │  images, thumbnails
                    └───────────────┘
```

## 2.2 The three-layer client split (read this twice)

The most common way an intern team destroys performance on this project is by putting canvas objects in React state and letting React re-render on every pointer move. **Do not.**

| Layer | Technology | Owns | Re-renders |
|---|---|---|---|
| **UI layer** | React components | Header, toolbar, panels, modals, toasts | Only when UI-relevant state changes (active tool, selection *count*, connection status, presence *list*) |
| **Render layer** | Plain TypeScript + `requestAnimationFrame` | Drawing pixels to the canvases | Never re-renders React. It reads the store directly and draws |
| **Sync layer** | Plain TypeScript class | The socket, the outbox, sequence numbers, reconnection | Never re-renders React except to update the connection status |

React subscribes to the store with **narrow selectors**. The renderer subscribes to the store with `store.subscribe()` outside React entirely.

```ts
// GOOD — React only re-renders when the tool changes
const tool = useBoardStore(s => s.activeTool)

// CATASTROPHIC — re-renders on every object mutation, 60 times a second
const objects = useBoardStore(s => s.objects)
```

If you need object data inside a React component (e.g. the properties panel), select **derived, minimal** data:

```ts
// The panel needs the fill colour of the single selected object, nothing more.
const fill = useBoardStore(s =>
  s.selection.length === 1 ? s.objects.get(s.selection[0])?.style.fill : undefined
)
```

---

# 3. Data model

## 3.1 Prisma schema

```prisma
model User {
  id            String   @id @default(uuid())
  email         String   @unique
  emailLower    String   @unique          // for case-insensitive lookup
  passwordHash  String?                    // null for OAuth-only accounts
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

model Board {
  id            String    @id @default(uuid())
  name          String    @db.VarChar(80) @default("Untitled board")
  ownerId       String
  thumbnailUrl  String?
  currentSeq    Int       @default(0)      // last assigned op sequence number
  objectCount   Int       @default(0)      // denormalized, for load decisions
  deletedAt     DateTime?                  // soft delete
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  lastActivityAt DateTime @default(now())

  owner         User          @relation("BoardOwner", fields: [ownerId], references: [id])
  members       BoardMember[]
  operations    Operation[]
  snapshots     Snapshot[]
  shareLinks    ShareLink[]

  @@index([ownerId, deletedAt])
  @@index([lastActivityAt])
}

model BoardMember {
  id        String   @id @default(uuid())
  boardId   String
  userId    String?                        // null for guests
  guestId   String?                        // client-generated uuid for guests
  guestName String?  @db.VarChar(40)
  role      Role
  addedById String?
  createdAt DateTime @default(now())
  lastSeenAt DateTime @default(now())

  board     Board    @relation(fields: [boardId], references: [id], onDelete: Cascade)
  user      User?    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([boardId, userId])
  @@unique([boardId, guestId])
  @@index([userId])
}

enum Role {
  OWNER
  EDITOR
  VIEWER
}

model ShareLink {
  id          String    @id @default(uuid())
  boardId     String
  token       String    @unique            // 32 bytes, base64url
  role        Role                          // EDITOR or VIEWER
  revokedAt   DateTime?
  createdById String
  createdAt   DateTime  @default(now())

  board       Board     @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@index([boardId])
  @@index([token])
}

model Operation {
  id         String   @id                  // CLIENT-generated uuid — the idempotency key
  boardId    String
  seq        Int                            // server-assigned, monotonic per board
  type       OpType
  objectId   String
  payload    Json                           // see §3.3
  actorId    String?                        // userId
  actorGuest String?                        // guestId
  createdAt  DateTime @default(now())

  board      Board    @relation(fields: [boardId], references: [id], onDelete: Cascade)
  actor      User?    @relation(fields: [actorId], references: [id], onDelete: SetNull)

  @@unique([boardId, seq])
  @@index([boardId, seq])
  @@index([boardId, objectId])
}

enum OpType {
  CREATE
  UPDATE
  DELETE
}

model Snapshot {
  id        String   @id @default(uuid())
  boardId   String
  seq       Int                             // state as of this sequence number
  state     Json                            // { objects: BoardObject[] }
  createdAt DateTime @default(now())

  board     Board    @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@index([boardId, seq])
}
```

## 3.2 Why an op log and not a mutable objects table

You may be tempted to add an `Object` table and `UPDATE` rows. Do not, and here is why:

| Property | Op log | Mutable table |
|---|---|---|
| Reconnect: "what did I miss since seq 412?" | One indexed query | Impossible without extra bookkeeping |
| Idempotent replay of a client's outbox | Free (unique op id) | Requires separate dedupe |
| Ordering authority | Built in (`seq`) | Needs a version column anyway |
| Auditability / future version history | Free | Lost |
| Write pattern | Append-only, no lock contention | Row-level contention on hot objects |

The cost is that reading a board means replaying ops. We solve that with snapshots (§3.4), which is a well-understood trade.

## 3.3 Object schema (the `payload` JSON)

```ts
type ObjectId  = string   // uuid v4, generated client-side
type CanvasX   = number & { readonly __brand: 'CanvasX' }
type CanvasY   = number & { readonly __brand: 'CanvasY' }

interface BaseObject {
  id: ObjectId
  type: 'stroke' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'sticky' | 'text' | 'image'
  x: number            // canvas coords, top-left of the bounding box
  y: number
  width: number
  height: number
  rotation: number     // degrees, 0–359.99
  zIndex: string       // FRACTIONAL index — see §6.4
  opacity: number      // 0–1
  createdBy: string
  createdAt: number    // client ms timestamp, display only, NEVER for ordering
  updatedAt: number
}

interface StrokeObject extends BaseObject {
  type: 'stroke'
  points: number[]          // FLAT array [x0,y0,p0, x1,y1,p1, …] — see below
  color: string             // #RRGGBB
  strokeWidth: number       // 1–24
  simplified: boolean
}

interface ShapeObject extends BaseObject {
  type: 'rect' | 'ellipse' | 'line' | 'arrow'
  stroke: string
  strokeWidth: number
  fill: string | 'none'
  cornerRadius?: number     // rect only
  arrowStart?: boolean      // arrow only
  arrowEnd?: boolean
}

interface StickyObject extends BaseObject {
  type: 'sticky'
  text: string              // max 2000 chars
  color: string             // one of the 8 palette colours
  fontSize: number | 'auto'
  textAlign: 'left' | 'center' | 'right'
}

interface TextObject extends BaseObject {
  type: 'text'
  text: string              // max 5000 chars
  color: string
  fontSize: number          // 8–128
  bold: boolean
  italic: boolean
  textAlign: 'left' | 'center' | 'right'
}

interface ImageObject extends BaseObject {
  type: 'image'
  url: string
  naturalWidth: number
  naturalHeight: number
  cornerRadius: number
}
```

### Why stroke points are a flat number array

`{x, y, pressure}[]` for a 200-point stroke allocates 200 objects and serializes to roughly 3× the bytes. A flat `number[]` with a stride of 3 is compact, cache-friendly, and fast to iterate. Access it as:

```ts
for (let i = 0; i < points.length; i += 3) {
  const x = points[i], y = points[i + 1], pressure = points[i + 2]
}
```

Never store screen coordinates. Ever. If a stored coordinate changes when the user pans, you have a critical bug.

## 3.4 Snapshot strategy

| Rule | Value |
|---|---|
| When to create | Every 500 ops, and on the last client leaving a board |
| How | Replay from the previous snapshot forward, not from seq 0 |
| Retention | Keep the latest 3 snapshots per board; delete older ones |
| Op retention | Keep all ops. They are small and cheap. `[P2]` prune ops older than the second-newest snapshot |
| Load path | `latest snapshot` + `ops WHERE seq > snapshot.seq` |
| Generation | Background job, not on the request path. If snapshot generation fails, loading still works — it is just slower |

---

# 4. REST API contract

Base: `/api`. All responses are JSON. Errors use a single shape:

```jsonc
{
  "error": {
    "code": "BOARD_NOT_FOUND",       // stable machine-readable code
    "message": "Board not found",    // developer-facing; never shown raw to users
    "details": { },                  // optional field-level errors
    "correlationId": "8f3a2b91"      // matches the server log entry
  }
}
```

## 4.1 Auth

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/auth/register` | `{email, password, displayName}` | 201 `{user, accessToken}` + refresh cookie | 409 `EMAIL_TAKEN`, 422 `VALIDATION`, 429 |
| POST | `/auth/login` | `{email, password}` | 200 `{user, accessToken}` + cookie | 401 `INVALID_CREDENTIALS`, 429 `RATE_LIMITED` |
| POST | `/auth/refresh` | — (cookie) | 200 `{accessToken}` + rotated cookie | 401 `INVALID_REFRESH` |
| POST | `/auth/logout` | — | 204 | — |
| GET | `/auth/me` | — | 200 `{user}` | 401 |
| GET | `/auth/google` | — | 302 to Google | — |
| GET | `/auth/google/callback` | `?code` | 302 to the client | 302 with `?error=` |
| POST | `/auth/forgot-password` | `{email}` | 200 always | 429 |
| GET | `/auth/reset/validate` | `?token` | 200 `{valid:true}` | 400 `TOKEN_INVALID`/`TOKEN_EXPIRED`/`TOKEN_USED` |
| POST | `/auth/reset` | `{token, password}` | 200 | 400, 422 |

## 4.2 Boards

| Method | Path | Body / Query | Success | Notes |
|---|---|---|---|---|
| GET | `/boards` | `?filter=all|owned|shared|starred&sort=&q=&cursor=` | 200 `{boards[], nextCursor}` | Cursor pagination, 24/page |
| POST | `/boards` | `{name?, templateId?}` | 201 `{board}` | Creator becomes OWNER |
| GET | `/boards/:id` | — | 200 `{board, myRole, members[]}` | 403/404 |
| PATCH | `/boards/:id` | `{name?}` | 200 `{board}` | Owner only. Broadcasts `board:renamed` |
| DELETE | `/boards/:id` | — | 204 | Soft delete. Broadcasts `board:deleted` |
| POST | `/boards/:id/restore` | — | 200 `{board}` | Owner only, within 30 days |
| DELETE | `/boards/:id/permanent` | `{confirmName}` | 204 | Name must match exactly |
| POST | `/boards/:id/duplicate` | — | 201 `{board}` | No members or links copied |
| POST | `/boards/:id/star` | `{starred:boolean}` | 200 | |
| GET | `/boards/:id/access` | `?shareToken=&guestId=` | 200 `{role, joinable, requiresName}` | Drives FLOWS §2.3 |
| GET | `/boards/:id/snapshot` | — | 200 `{objects[], seq, meta}` | Snapshot + tail ops, merged server-side |
| GET | `/boards/:id/operations` | `?sinceSeq=&limit=` | 200 `{ops[], hasMore}` | Reconnect gap-fill fallback |
| PUT | `/boards/:id/thumbnail` | `multipart` | 200 `{url}` | Client-rendered JPEG |

## 4.3 Members and sharing

| Method | Path | Body | Success | Notes |
|---|---|---|---|---|
| GET | `/boards/:id/members` | — | 200 `{members[]}` | |
| POST | `/boards/:id/members` | `{emails[], role}` | 200 `{added[], invited[]}` | Owner only |
| PATCH | `/boards/:id/members/:memberId` | `{role}` | 200 | Owner only. Emits `role:changed` |
| DELETE | `/boards/:id/members/:memberId` | — | 204 | Emits `access:revoked` |
| DELETE | `/boards/:id/members/me` | — | 204 | "Leave board" |
| GET | `/boards/:id/share-link` | — | 200 `{token, role, url} \| null` | |
| POST | `/boards/:id/share-link` | `{role}` | 201 `{token, url}` | Creates or replaces |
| DELETE | `/boards/:id/share-link` | — | 204 | Revokes; ejects link users |
| GET | `/share/:token` | — | 200 `{boardId, boardName, ownerName, activeCount}` | Public, no auth |
| POST | `/share/:token/join` | `{guestId, name}` | 200 `{boardId, role}` | Creates a guest BoardMember |

## 4.4 Uploads

| Method | Path | Body | Success | Notes |
|---|---|---|---|---|
| POST | `/uploads/presign` | `{filename, contentType, size}` | 200 `{uploadUrl, publicUrl, key}` | Validates type and size before issuing a URL |
| POST | `/uploads/confirm` | `{key}` | 200 `{url}` | Verifies the object exists; sanitizes SVG |

**Do not proxy image bytes through the Node server.** Presigned direct-to-S3 uploads keep the event loop free.

---

# 5. WebSocket protocol

## 5.1 Connection lifecycle

```
Client                                    Server
  │                                          │
  ├─ WSS connect to /ws?boardId=X ──────────►│
  │   Authorization via:                     │
  │     a) `Sec-WebSocket-Protocol` bearer   ├─ verify access token OR
  │        subprotocol carrying the token    │   guest identity + share token
  │     b) or a short-lived ticket obtained  ├─ resolve role via PermissionService
  │        from POST /api/ws/ticket          │
  │                                          ├─ reject → close(4001, "unauthorized")
  │                                          │
  ├─ { t: "join", boardId, sinceSeq } ──────►│
  │                                          ├─ add the socket to room(boardId)
  │◄─ { t: "join_ack", seq, role, users[],   ┤
  │      sessionId, colour } ────────────────┤
  │                                          │
  │◄─ { t: "op_batch", ops[] } ──────────────┤  (only if sinceSeq < currentSeq)
  │                                          │
  ├─ { t: "ping" } every 25 s ──────────────►│
  │◄─ { t: "pong" } ─────────────────────────┤
```

**Heartbeat rules:**
- The client sends `ping` every 25 s. If no `pong` arrives within 10 s, the client treats the connection as dead and reconnects. Do not rely on the socket's `close` event — a half-open TCP connection can hang for minutes.
- The server terminates any socket that has not sent a message in 60 s.

## 5.2 Message envelope

Every message is JSON with a short `t` (type) discriminator. Keys are terse because these fly at 20 Hz per user.

```ts
type ClientMessage =
  | { t: 'join';     boardId: string; sinceSeq: number }
  | { t: 'op';       op: ClientOp }
  | { t: 'op_batch'; ops: ClientOp[] }
  | { t: 'cursor';   x: number; y: number }
  | { t: 'sel';      ids: string[] }
  | { t: 'stroke';   id: string; pts: number[]; done: boolean }
  | { t: 'xform';    ids: string[]; dx: number; dy: number }
  | { t: 'ping' }

type ServerMessage =
  | { t: 'join_ack'; seq: number; role: Role; sessionId: string
      colour: string; users: PresenceUser[] }
  | { t: 'op_batch'; ops: ServerOp[] }
  | { t: 'ack';      ids: string[]; seqs: number[] }
  | { t: 'nack';     id: string; code: string; message: string }
  | { t: 'presence_join';  user: PresenceUser }
  | { t: 'presence_leave'; sessionId: string }
  | { t: 'cursor';   sessionId: string; x: number; y: number }
  | { t: 'sel';      sessionId: string; ids: string[] }
  | { t: 'stroke';   sessionId: string; id: string; pts: number[]; done: boolean }
  | { t: 'xform';    sessionId: string; ids: string[]; dx: number; dy: number }
  | { t: 'board_renamed';  name: string }
  | { t: 'board_deleted' }
  | { t: 'role_changed';   role: Role }
  | { t: 'access_revoked' }
  | { t: 'pong' }

interface ClientOp {
  id: string          // client-generated uuid — the idempotency key
  type: 'CREATE' | 'UPDATE' | 'DELETE'
  objectId: string
  payload: unknown    // full object for CREATE, partial for UPDATE, {} for DELETE
}

interface ServerOp extends ClientOp {
  seq: number
  actorSessionId: string
}
```

## 5.3 The critical distinction: ops vs presence

| | Ops | Presence |
|---|---|---|
| Examples | create/update/delete object | cursor, selection, in-progress stroke, drag preview |
| Persisted | **Yes**, to Postgres | **Never** |
| Sequence number | Yes | No |
| Acknowledged | Yes | No |
| Queued in the outbox when offline | Yes | No — dropped |
| Rate | Low (user actions) | High (20 Hz per user) |
| Lost message consequence | Data loss — unacceptable | A cursor stutters — irrelevant |

If you find yourself writing a cursor position to the database, stop. If you find yourself dropping a create-object message because the outbox was full, stop.

## 5.4 Server-side message handling

```ts
async function handleOp(session: Session, op: ClientOp) {
  // 1. AUTHORIZE — every single message, no exceptions
  if (session.role === 'VIEWER') {
    return send(session, { t: 'nack', id: op.id, code: 'FORBIDDEN',
                           message: 'View-only access' })
  }

  // 2. VALIDATE against the Zod schema for op.type
  const parsed = OpSchema.safeParse(op)
  if (!parsed.success) {
    return send(session, { t: 'nack', id: op.id, code: 'INVALID_OP',
                           message: 'Malformed operation' })
  }

  // 3. RATE LIMIT — token bucket in Redis, 100 ops/sec per session
  if (!(await rateLimiter.consume(session.id))) {
    return send(session, { t: 'nack', id: op.id, code: 'RATE_LIMITED',
                           message: 'Slow down' })
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
      data: { id: op.id, boardId: session.boardId, seq: board.currentSeq,
              type: op.type, objectId: op.objectId, payload: op.payload,
              actorId: session.userId, actorGuest: session.guestId },
    })
    return board.currentSeq
  })

  // 6. ACK the sender FIRST — they are waiting to clear their outbox
  send(session, { t: 'ack', ids: [op.id], seqs: [seq] })

  // 7. BROADCAST to everyone else in the room (and via Redis pub/sub to
  //    sessions on other server instances)
  broadcastExcept(session.boardId, session.id,
                  { t: 'op_batch', ops: [{ ...op, seq, actorSessionId: session.id }] })
}
```

**Note step 5:** the `increment` inside a transaction is what makes `seq` monotonic and gap-free under concurrency. Postgres serializes the row update, so two simultaneous ops cannot receive the same sequence number. Do not compute the next seq with a `SELECT MAX(seq)` outside a transaction — that is a race condition waiting to happen.

## 5.5 Batching

- The client batches ops emitted within the same animation frame into one `op_batch` message.
- The server batches broadcasts on a 16 ms timer per room: collect ops, flush once per frame. With 20 users this turns 20 messages into 1.
- Never batch a `nack`. Errors go out immediately.

## 5.6 Close codes

| Code | Meaning | Client reaction |
|---|---|---|
| 1000 | Normal | No reconnect |
| 1001 | Going away (page unload) | No reconnect |
| 1006 | Abnormal (network) | Reconnect with backoff |
| 4001 | Unauthorized | Do **not** reconnect. Attempt a token refresh, then reconnect once |
| 4003 | Forbidden (role revoked) | Do not reconnect. Show S-17 |
| 4004 | Board not found / deleted | Do not reconnect. Show S-18/S-19 |
| 4029 | Rate limited / too many connections | Reconnect after 30 s |

---

# 6. Conflict resolution and convergence

## 6.1 The model: server-ordered, last-writer-wins per field

We are **not** implementing OT or a full CRDT. Here is the honest reasoning:

| Approach | Correctness | Complexity | Right for us? |
|---|---|---|---|
| Operational Transformation | Excellent for text | Very high; transform functions are notoriously subtle | No |
| CRDT (Yjs/Automerge) | Excellent | Low if you use a library, very high if you write one | No — using a library hides the learning; writing one is a semester project |
| **Server-ordered LWW per field** | **Sufficient for a whiteboard** | **Low** | **Yes** |

The key insight: whiteboard objects are **spatially separated**. Two people rarely edit the same property of the same object at the same instant. When they do, one of them losing is acceptable and expected — this is exactly how Figma behaves for most properties. Text is the hard case, and our text lives inside individual objects where simultaneous editing of one sticky note is rare and the last-writer-wins outcome is understandable.

## 6.2 The resolution algorithm

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

**Three properties this gives us, which you should be able to explain in a code review:**

1. **Commutative for disjoint objects.** Ops on different objects can arrive in any order and produce the same state.
2. **Idempotent.** Applying the same op twice is a no-op, so replays after a reconnect are safe.
3. **Convergent.** Ops are applied in server-`seq` order, so every client that has received the same op set holds the same state.

The reason `UPDATE` merges only the fields present in the payload (rather than replacing the whole object) is what allows "A moves it, B recolours it" to preserve both changes. **Always send partial payloads on update.** Sending the full object on every update turns every concurrent edit into a lost update.

## 6.3 Ordered application and gap handling

```ts
// Ops MUST be applied in seq order. Never apply out of order.
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

## 6.4 Fractional z-indexing

Storing `zIndex` as an integer means inserting between two objects requires renumbering everything above — an O(n) op storm. Instead, `zIndex` is a **string key** ordered lexicographically (the LexoRank / Figma approach).

```
Object A: "a0"
Object B: "a1"
Insert between: "a0V"        // lexicographically between "a0" and "a1"
```

Use the `fractional-indexing` npm package. Rules:
- New objects get a key generated after the current maximum.
- "Bring to front" generates a key after the maximum; "send to back" generates one before the minimum.
- Two users reordering simultaneously produce two valid distinct keys, so nothing breaks — the objects simply end up in an order determined by the string comparison.
- Sorting for render happens once per object-set change, not every frame. Cache the sorted array and invalidate it on create/delete/z-change.

## 6.5 Convergence testing (build this in week 4, not week 8)

A debug panel behind `?debug=1` showing:
- `lastAppliedSeq`
- `objects.size`
- A **state hash**: a stable hash of all objects sorted by id, with float coordinates rounded to 2 decimals.

Two clients on the same board with the same `lastAppliedSeq` must show the same hash. Put this in an automated Playwright test: drive two browser contexts through 200 random operations, then assert that the hashes match. This one test will catch more real bugs than any other you write on this project.

---

# 7. Canvas rendering engine

## 7.1 Layer setup

Four stacked `<canvas>` elements, absolutely positioned, identical dimensions (see FLOWS §14.3). Each canvas is sized for device pixel ratio:

```ts
function resizeCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)   // cap at 2 — 3x on
  canvas.width  = Math.floor(cssW * dpr)                  // some phones is
  canvas.height = Math.floor(cssH * dpr)                  // ruinous for perf
  canvas.style.width  = `${cssW}px`
  canvas.style.height = `${cssH}px`
  canvas.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0)
}
```

## 7.2 The render loop

```ts
class Renderer {
  private dirty = { objects: true, interaction: true, overlay: true }
  private rafId = 0

  start() { this.rafId = requestAnimationFrame(this.tick) }
  stop()  { cancelAnimationFrame(this.rafId) }

  markDirty(layer: keyof typeof this.dirty) { this.dirty[layer] = true }

  private tick = () => {
    if (this.dirty.objects)     { this.drawObjects();     this.dirty.objects = false }
    if (this.dirty.interaction) { this.drawInteraction(); this.dirty.interaction = false }
    if (this.dirty.overlay)     { this.drawOverlay();     this.dirty.overlay = false }
    this.rafId = requestAnimationFrame(this.tick)
  }
}
```

**Rules:**
- Exactly **one** `requestAnimationFrame` loop in the entire application. Not one per layer, not one per component.
- Never draw synchronously from an event handler. Event handlers mutate state and call `markDirty`. The loop draws.
- The loop runs continuously but does nothing when no layer is dirty — the cost of an idle tick is negligible and it keeps the code simple.
- Stop the loop on `visibilitychange` → hidden, restart on visible.

## 7.3 Viewport transform and coordinate conversion

```ts
interface Viewport { x: number; y: number; zoom: number }

// canvas → screen
const canvasToScreen = (p: CanvasPoint, v: Viewport): ScreenPoint => ({
  x: p.x * v.zoom + v.x,
  y: p.y * v.zoom + v.y,
})

// screen → canvas
const screenToCanvas = (p: ScreenPoint, v: Viewport): CanvasPoint => ({
  x: (p.x - v.x) / v.zoom,
  y: (p.y - v.y) / v.zoom,
})
```

Use **branded types** so the compiler catches mixing them up:

```ts
type CanvasPoint = { x: number; y: number; __brand: 'canvas' }
type ScreenPoint = { x: number; y: number; __brand: 'screen' }
```

This will feel pedantic in week 1 and will save you a full day of debugging in week 5. Risk R-7 in the PRD is this exact bug.

Apply the transform once per frame rather than per object:

```ts
ctx.save()
ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
ctx.clearRect(0, 0, w, h)
ctx.translate(viewport.x, viewport.y)
ctx.scale(viewport.zoom, viewport.zoom)
// …draw every object in CANVAS coordinates…
ctx.restore()
```

## 7.4 Viewport culling

```ts
function getVisibleObjects(objects: BoardObject[], v: Viewport, w: number, h: number) {
  const pad = 100 / v.zoom                       // margin so objects don't pop in
  const view = {
    minX: -v.x / v.zoom - pad,
    minY: -v.y / v.zoom - pad,
    maxX: (w - v.x) / v.zoom + pad,
    maxY: (h - v.y) / v.zoom + pad,
  }
  return objects.filter(o =>
    o.x + o.width  >= view.minX && o.x <= view.maxX &&
    o.y + o.height >= view.minY && o.y <= view.maxY)
}
```

For v1 a linear filter is fine up to ~10,000 objects. If profiling shows it is a bottleneck, add a spatial index (a uniform grid with 512-unit cells is simpler than a quadtree and performs comparably at our scale). **Do not build the spatial index preemptively.** Measure first.

## 7.5 Stroke rendering and smoothing

Raw pointer points produce visibly polygonal lines. Render with quadratic curves through midpoints:

```ts
function drawStroke(ctx: CanvasRenderingContext2D, s: StrokeObject) {
  const p = s.points
  if (p.length < 6) return                       // fewer than 2 points

  ctx.beginPath()
  ctx.strokeStyle = s.color
  ctx.lineWidth   = s.strokeWidth
  ctx.lineCap     = 'round'
  ctx.lineJoin    = 'round'
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

**Simplification before commit** (Ramer–Douglas–Peucker, ε = 0.5 canvas units): a 3-second scribble produces roughly 400 raw points and simplifies to around 60 with no visible difference. That is a 6× reduction in payload size, database storage, and per-frame draw cost. Run it once on `pointerup`, never during the stroke.

## 7.6 Performance rules (non-negotiable)

| Rule | Reason |
|---|---|
| Batch by style. Sort visible objects by `strokeStyle`/`fillStyle` and set the context property only when it changes | Context state changes are the dominant cost in Canvas 2D |
| Never call `getImageData` in the render path | It forces a GPU→CPU sync and destroys the frame rate |
| Cap DPR at 2 | 3× DPR quadruples the fill cost for no visible gain |
| Below 25% zoom, draw strokes as polylines with no curve interpolation | Curves are invisible at that scale |
| Below 10% zoom, draw objects as filled bounding boxes `[P2]` | Detail is meaningless |
| Cache images in a `Map<url, HTMLImageElement>` | Never construct an `Image` in the draw loop |
| Redraw layer 1 only when objects or the viewport change | Cursor movement must never touch it |
| Use integer coordinates for 1 px lines, or offset by 0.5 | Otherwise lines render blurry across two pixels |
| Never allocate objects inside the draw loop | GC pauses show up as dropped frames |

## 7.7 Hit testing

```ts
function hitTest(point: CanvasPoint, objects: BoardObject[]): BoardObject | null {
  // Iterate in REVERSE z-order — topmost object wins
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i]
    // Phase 1: cheap AABB rejection (accounting for rotation via the
    //          rotated bounding box)
    if (!pointInBounds(point, o)) continue
    // Phase 2: precise test per type
    if (preciseHitTest(point, o)) return o
  }
  return null
}
```

| Type | Precise test |
|---|---|
| rect, sticky, image | Bounding box (with a corner-radius check when the radius is large) |
| ellipse | `((dx/rx)² + (dy/ry)²) ≤ 1` |
| line, arrow | Distance from the point to the segment ≤ `strokeWidth/2 + 4/zoom` |
| stroke | Distance to any segment ≤ `strokeWidth/2 + 4/zoom`; early-exit on the first hit |
| text | Bounding box |

The `+ 4/zoom` term is a constant 4-pixel screen-space tolerance so thin lines remain clickable at any zoom level. Without it, a 1 px line at 10% zoom is impossible to select.

For rotated objects, transform the test point into the object's local space (translate to centre, rotate by `−rotation`, translate back) and then test axis-aligned.

---

# 8. Undo/redo implementation

## 8.1 The model: local inverse-op stacks

```ts
interface HistoryEntry {
  forward: ClientOp[]       // what the user did
  inverse: ClientOp[]       // what undoes it
  label: string             // for debugging and a future history panel
}

class HistoryManager {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private readonly MAX = 100

  push(entry: HistoryEntry) {
    this.undoStack.push(entry)
    if (this.undoStack.length > this.MAX) this.undoStack.shift()
    this.redoStack = []              // ANY new action clears redo. Always.
  }

  undo() {
    let attempts = 0
    while (this.undoStack.length && attempts++ < 10) {
      const entry = this.undoStack.pop()!
      if (!this.isApplicable(entry.inverse)) continue   // stale: skip silently
      applyAndEmit(entry.inverse)
      this.redoStack.push(entry)
      return
    }
  }

  redo() { /* symmetric */ }

  // An entry is stale if it targets an object that no longer exists.
  private isApplicable(ops: ClientOp[]) {
    return ops.every(op =>
      op.type === 'CREATE' || store.objects.has(op.objectId))
  }
}
```

## 8.2 Inverse op construction

| Forward op | Inverse op |
|---|---|
| `CREATE(obj)` | `DELETE(obj.id)` |
| `DELETE(obj)` | `CREATE(snapshot of obj taken BEFORE deletion)` |
| `UPDATE(id, {fill: 'red'})` | `UPDATE(id, {fill: <previous value>})` |

**You must capture the previous values before applying the update.** This is the step everyone forgets:

```ts
function updateObject(id: string, changes: Partial<BoardObject>) {
  const before = store.objects.get(id)
  if (!before) return
  // Capture ONLY the keys being changed — not the whole object
  const inverseChanges = Object.fromEntries(
    Object.keys(changes).map(k => [k, (before as any)[k]])
  )
  const forward = { id: uuid(), type: 'UPDATE', objectId: id, payload: changes }
  const inverse = { id: uuid(), type: 'UPDATE', objectId: id, payload: inverseChanges }
  applyAndEmit(forward)
  history.push({ forward: [forward], inverse: [inverse], label: 'update' })
}
```

Capturing only the changed keys (rather than the whole object) is what keeps undo from clobbering a teammate's concurrent edit to a *different* field.

## 8.3 The five rules of collaborative undo

1. **Only your own ops enter your history stack.** Remote ops applied via `receiveOps` must never call `history.push`. Enforce this with a distinct code path: `applyRemoteOp` does not touch history; `applyAndEmit` does.
2. **An undo is emitted as a normal op.** Other clients see it as an ordinary update. There is no special "undo" message type.
3. **A multi-object action is one history entry.** Dragging 10 objects pushes one entry containing 10 forward ops and 10 inverse ops. Undo must move all 10 back in one keypress.
4. **A stale entry is skipped, not applied.** If the object was deleted by someone else, skip that entry and try the next, up to a limit of 10 skips.
5. **History does not survive a reload.** We deliberately do not persist it. Persisting undo history across sessions creates confusing cross-session behaviour for a marginal benefit.

## 8.4 Grouping rules

| Action | Entries pushed |
|---|---|
| One stroke | 1 |
| Drag 10 objects | 1 (containing 10 ops) |
| Delete a multi-selection | 1 |
| Typing in a sticky note | 1 per "burst" — coalesce updates that occur within 1 s of each other on the same object |
| Resize | 1, pushed on `pointerup`, not on every `pointermove` |
| Paste 5 objects | 1 |

---

# 9. Client state architecture

## 9.1 Store shape

```ts
interface BoardStore {
  // ─── Document state (mutated by ops) ───
  boardId: string | null
  boardName: string
  objects: Map<ObjectId, BoardObject>
  tombstones: Set<ObjectId>
  sortedIds: ObjectId[]                  // cached z-order; invalidated on change

  // ─── Viewport ───
  viewport: Viewport

  // ─── Local UI state (never synced) ───
  activeTool: Tool
  toolSettings: Record<Tool, ToolSettings>
  selection: ObjectId[]
  interaction: InteractionState          // the §15.1 state machine
  editingTextId: ObjectId | null

  // ─── Presence (ephemeral, from remote) ───
  presence: Map<SessionId, PresenceUser>
  remoteCursors: Map<SessionId, { x: number; y: number; t: number }>
  remoteSelections: Map<SessionId, ObjectId[]>
  remoteStrokes: Map<SessionId, { id: string; pts: number[] }>

  // ─── Connection ───
  connection: 'disconnected'|'connecting'|'syncing'|'connected'|'reconnecting'|'offline'
  reconnectAttempt: number
  outboxSize: number
  lastAppliedSeq: number
  myRole: Role
  mySessionId: string | null
}
```

## 9.2 Why a `Map` and not an array or a plain object

| Operation | `Map` | Array | Object |
|---|---|---|---|
| Lookup by id | O(1) | O(n) | O(1) |
| Insert | O(1) | O(1) | O(1) |
| Delete | O(1) | O(n) | O(1) |
| Iterate in insertion order | Yes | Yes | Not guaranteed for integer-like keys |
| Key type safety | Yes | — | Coerces to string |

Hot paths run at 60 Hz. O(n) lookups on 5,000 objects will destroy the frame budget.

**Zustand caveat:** Zustand compares by reference. Mutating a `Map` in place does not trigger subscribers. Either construct a new `Map` on write (fine for occasional updates) or, for the high-frequency path, mutate in place and use an explicit `version` counter that the renderer watches. We use the latter for object mutations during drags and the former everywhere else.

## 9.3 Module structure

```
apps/web/src/
├── main.tsx
├── App.tsx                          # router + providers
├── routes/
│   ├── guards.tsx                   # requireAuth, requireBoardAccess
│   ├── Landing.tsx
│   ├── Login.tsx  Signup.tsx  ForgotPassword.tsx  ResetPassword.tsx
│   ├── OAuthCallback.tsx
│   ├── Dashboard.tsx  Trash.tsx  Settings.tsx
│   ├── GuestEntry.tsx
│   └── Board.tsx                    # the S-10 shell
├── features/
│   ├── auth/         hooks, api, forms
│   ├── boards/       BoardCard, BoardGrid, useBoards, api
│   ├── canvas/
│   │   ├── Canvas.tsx               # mounts the 4 layers, wires events
│   │   ├── renderer/
│   │   │   ├── Renderer.ts          # the single rAF loop
│   │   │   ├── drawObjects.ts       drawInteraction.ts  drawOverlay.ts
│   │   │   └── shapes/              stroke.ts rect.ts ellipse.ts …
│   │   ├── interaction/
│   │   │   ├── machine.ts           # the §15.1 state machine
│   │   │   ├── usePointer.ts        useKeyboard.ts  useWheel.ts
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
├── lib/              api.ts  cn.ts  throttle.ts  colours.ts
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
│   ├── RoomManager.ts
│   ├── Session.ts
│   └── handlers/     op.ts presence.ts join.ts
├── services/         AuthService.ts BoardService.ts OpService.ts
│                     PermissionService.ts SnapshotService.ts PresenceService.ts
├── db/               prisma client, migrations
└── lib/              redis.ts s3.ts logger.ts jwt.ts
```

**Module ownership.** Assign each of `canvas/renderer`, `canvas/interaction`, `sync`, and `features/boards + auth` to a different person. These four boundaries are chosen so that people rarely edit the same file, which is the practical answer to PRD risk R-9.

---

# 10. Sync engine implementation

## 10.1 Outbox

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
    const batch = this.queue.splice(0, 50)              // cap the batch size
    for (const op of batch) this.inflight.set(op.id, op)
    socket.send({ t: 'op_batch', ops: batch })
    this.persist()
  }

  onAck(ids: string[]) {
    for (const id of ids) this.inflight.delete(id)
    this.persist()
  }

  onNack(id: string) {
    this.inflight.delete(id)                             // do NOT retry a nack
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
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
        boardId: this.boardId,
        ops: [...this.inflight.values(), ...this.queue],
      }))
    } catch { /* quota or private mode — degrade silently */ }
  }
}
```

The reason a nacked op is not retried: a nack means the server made a decision (forbidden, invalid, rate-limited). Retrying will produce the same decision. Retry loops on rejected ops are how you accidentally DDoS your own server.

## 10.2 Reconnection with backoff

```ts
private getBackoffDelay(attempt: number): number {
  const base = Math.min(1000 * Math.pow(2, attempt), 30_000)
  return Math.random() * base            // FULL jitter
}
```

Full jitter (a random value in `[0, base]`, not `base ± jitter`) is important: if the server restarts and 50 clients reconnect simultaneously, unjittered backoff makes them all retry in lockstep and hammer the server in synchronized waves. Full jitter spreads them evenly.

Additional triggers that bypass the backoff timer and retry immediately:
- `window` `online` event.
- `document.visibilitychange` → visible (a backgrounded tab's socket is often silently dead).
- The user clicking "Retry now".

## 10.3 Presence throttling

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

Sending deltas rather than the full point array is a significant win: a 400-point stroke sent in full 20 times per second is roughly 100 KB/s per user. Deltas reduce that to a few hundred bytes per message.

## 10.4 Remote cursor interpolation

```ts
// Store the target and the previous position with timestamps; interpolate in
// the render loop so the cursor glides rather than teleporting every 50 ms.
function interpolateCursor(c: RemoteCursor, now: number) {
  const t = Math.min((now - c.updatedAt) / 50, 1)
  return {
    x: c.prevX + (c.x - c.prevX) * t,
    y: c.prevY + (c.y - c.prevY) * t,
  }
}
```

---

# 11. Security implementation

## 11.1 Token strategy

| Token | Storage | Lifetime | Notes |
|---|---|---|---|
| Access | **In memory only** (a module variable, never `localStorage`) | 15 min | Sent as `Authorization: Bearer` |
| Refresh | `httpOnly`, `Secure`, `SameSite=Lax` cookie | 30 days | Rotated on every use; the old one is revoked |
| WS ticket | In memory | 60 s, single use | Obtained from `POST /api/ws/ticket`, passed as a query param on the socket URL |

Access tokens are never in `localStorage` because any XSS can then exfiltrate them. Refresh tokens are `httpOnly` so JavaScript cannot read them at all.

**Refresh token rotation with reuse detection:** each refresh issues a new token and revokes the old one. If a revoked token is presented, that indicates theft — revoke the entire token family for that user and force a re-login.

## 11.2 The permission check that must exist on every path

```ts
async function assertCanEdit(session: Session) {
  const role = await permissionService.getRole(session.boardId, session.identity)
  if (role !== 'OWNER' && role !== 'EDITOR') {
    throw new ForbiddenError('EDIT_FORBIDDEN')
  }
}
```

Called on: every op message, every board mutation endpoint, and the upload presign endpoint. Cached in Redis for 60 s per `(boardId, identity)` and invalidated on any role change.

**A viewer with the developer console open will try `socket.send({t:'op', …})`.** The client-side disabled toolbar is UX; the server check is security. Test AT-20 exists precisely to verify this.

## 11.3 Input validation at the boundary

```ts
// packages/shared/src/schemas/op.ts
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
  points: z.array(z.number().finite()).min(6).max(30_000),   // 10k points max
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  strokeWidth: z.number().min(1).max(24),
})
```

Every numeric field has explicit bounds. `NaN` and `Infinity` are rejected by `.finite()` — an `Infinity` in a coordinate propagates through the renderer and blanks the canvas for **every** user in the room, which is both a bug and a denial-of-service vector.

## 11.4 Security checklist

- [ ] All traffic over HTTPS/WSS; HSTS with a 1-year max-age
- [ ] bcrypt cost 12; password hashes never leave the server
- [ ] Generic auth errors — never reveal whether an email is registered
- [ ] Rate limits: login 5/15 min per email + 20/15 min per IP; ops 100/s per session; uploads 20/h per user
- [ ] Share tokens are 32 bytes from `crypto.randomBytes`, base64url encoded
- [ ] Every socket message authorized server-side
- [ ] Every payload validated with Zod at the boundary; reject, never coerce
- [ ] No `dangerouslySetInnerHTML` anywhere in the codebase (add an ESLint rule)
- [ ] SVG uploads sanitized with DOMPurify server-side
- [ ] Uploads validated by magic bytes, not by the client-supplied MIME type
- [ ] CORS restricted to an explicit origin allow-list
- [ ] CSP header: `default-src 'self'; img-src 'self' data: blob: <s3-domain>; connect-src 'self' <ws-domain>`
- [ ] Prisma parameterizes all queries — no raw SQL string interpolation
- [ ] Secrets in environment variables; `.env` git-ignored; `.env.example` committed
- [ ] `npm audit` in CI blocking on high/critical
- [ ] No user IDs, emails, or tokens in client-visible error messages

---

# 12. Performance engineering

## 12.1 Where the frames go

Profile before optimizing. Typical distribution at 5,000 objects:

| Cost | Share | Fix |
|---|---|---|
| Canvas context state changes | ~40% | Batch by style |
| Path construction | ~25% | Simplify strokes; cull |
| React re-renders | ~20% | Narrow selectors; keep objects out of React |
| Hit testing | ~10% | AABB pre-filter; spatial index only if measured |
| Serialization | ~5% | Delta presence; batch ops |

## 12.2 Bundle splitting

```ts
const Board     = lazy(() => import('./routes/Board'))
const Dashboard = lazy(() => import('./routes/Dashboard'))
const Settings  = lazy(() => import('./routes/Settings'))
```

The landing and auth routes must not pull in the canvas engine. Enforce the budgets from PRD §7.1 in CI with `rollup-plugin-visualizer` plus a size check that fails the build on a regression.

## 12.3 Memory

| Leak source | Prevention |
|---|---|
| Socket listeners | Every `addEventListener` has a matching remove in the effect cleanup |
| `requestAnimationFrame` | `cancelAnimationFrame` on unmount |
| Image cache | Cap at 100 entries with LRU eviction |
| Presence maps | Delete the entry on `presence_leave`; sweep entries idle for over 60 s |
| Tombstones | Cleared on board unload; capped at 10,000 with FIFO eviction |
| Undo history | Hard cap at 100 entries |
| Detached canvases | Null the refs on unmount |

Test: open a board, use it for 30 minutes, take a heap snapshot, close and reopen the board 10 times, force GC, take another snapshot. Growth should be near zero.

---

# 13. Testing strategy

## 13.1 Pyramid

| Level | Tool | Coverage target | What |
|---|---|---|---|
| Unit | Vitest | 80% of `lib`, `geometry`, `history`, `sync` | Pure functions: hit tests, transforms, simplification, inverse ops, backoff, conflict resolution |
| Component | Testing Library | Key flows | Forms, modals, board cards, toolbar |
| Integration | Vitest + supertest | All endpoints | REST contracts, auth, permissions |
| Socket | Vitest + `ws` client | All message types | Join, op, ack, nack, presence, reconnect |
| E2E | Playwright | Every PRD §11 scenario | Multi-context collaboration |

## 13.2 The tests that actually matter

Write these first. They are the ones that catch real bugs.

```ts
// 1. CONVERGENCE — the single most valuable test in the project
test('two clients converge after 200 random concurrent operations', async () => {
  const [a, b] = await openTwoClientsOnSameBoard()
  await Promise.all([
    driveRandomOperations(a, 100, { seed: 42 }),
    driveRandomOperations(b, 100, { seed: 99 }),
  ])
  await waitForBothIdle(a, b)
  expect(await stateHash(a)).toBe(await stateHash(b))
})

// 2. OFFLINE MERGE
test('offline edits merge without loss', async () => {
  const [a, b] = await openTwoClientsOnSameBoard()
  await a.setOffline(true)
  await drawStrokes(a, 10)
  await drawStrokes(b, 10)
  await a.setOffline(false)
  await waitForSync(a)
  expect(await objectCount(a)).toBe(20)
  expect(await objectCount(b)).toBe(20)
  expect(await stateHash(a)).toBe(await stateHash(b))
})

// 3. COLLABORATIVE UNDO
test('undo does not revert another user\'s work', async () => {
  const [a, b] = await openTwoClientsOnSameBoard()
  const strokeA = await drawStroke(a)
  const strokeB = await drawStroke(b)
  await pressUndo(a)
  expect(await hasObject(b, strokeA)).toBe(false)
  expect(await hasObject(b, strokeB)).toBe(true)   // B's work is untouched
})

// 4. DELETE BEATS UPDATE
test('delete wins over a concurrent move', async () => {
  const [a, b] = await openTwoClientsOnSameBoard()
  const id = await createRect(a)
  await waitForSync(b)
  await Promise.all([deleteObject(b, id), moveObject(a, id, 100, 100)])
  await waitForBothIdle(a, b)
  expect(await hasObject(a, id)).toBe(false)
  expect(await hasObject(b, id)).toBe(false)
})

// 5. SERVER-SIDE PERMISSION ENFORCEMENT
test('a viewer cannot mutate the board even with a forged socket message', async () => {
  const viewer = await joinAsViewer(boardId)
  const res = await viewer.sendRaw({ t: 'op', op: makeCreateOp() })
  expect(res.t).toBe('nack')
  expect(res.code).toBe('FORBIDDEN')
  expect(await objectCountInDb(boardId)).toBe(0)
})
```

## 13.3 Manual QA checklist per release

1. Two windows side by side, draw for 2 minutes, compare state hashes.
2. Chrome DevTools → Network → Offline, draw 10 strokes, go back online.
3. Throttle to Slow 3G and confirm local drawing stays instant.
4. Load the committed 10,000-object stress board and check the frame rate while panning.
5. Zoom to 10% and to 500% and confirm hit testing still works.
6. Full keyboard-only pass through every non-canvas screen.
7. Every breakpoint in PRD §7.7.
8. Safari, Firefox, Chrome — strokes must look identical.
9. Kill and restart the server mid-session.
10. Trash a board with three people connected.

---

# 14. Development workflow

## 14.1 Environment

```bash
git clone <repo> && cd coboard
cp .env.example .env
docker compose up -d           # postgres + redis
pnpm install
pnpm db:migrate
pnpm db:seed                   # includes the 10k-object stress board
pnpm dev                       # web :5173, server :3000
```

## 14.2 Branches, commits, PRs

- Branches: `feat/…`, `fix/…`, `chore/…`, `docs/…`
- Commits: Conventional Commits — `feat(canvas): add rotation handle`
- PRs must include: the requirement IDs implemented, a screenshot or clip for UI work, test evidence, and a note on any performance impact.
- PRs are capped at ~400 changed lines. A 2,000-line PR will not be reviewed properly, and everyone involved knows it.

## 14.3 CI gates

| Gate | Blocking |
|---|---|
| `tsc --noEmit` | Yes |
| ESLint (no warnings) | Yes |
| Unit + integration tests | Yes |
| Bundle size budget | Yes |
| `npm audit` high/critical | Yes |
| Playwright e2e | Yes on `main`, advisory on PRs |
| Lighthouse CI | Advisory |

## 14.4 Definition of Done

See PRD §10.1. It is a checklist, not a suggestion, and reviewers enforce it.

---

# 15. Deployment

## 15.1 Topology

```
        Cloudflare (TLS, DDoS, static caching)
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
   Static host              Load balancer (sticky sessions
   (Vercel/Netlify)          via ip_hash for WebSocket)
   React SPA                      │
                       ┌──────────┴──────────┐
                       ▼                     ▼
                  Node instance 1      Node instance 2
                       │                     │
                       └──────────┬──────────┘
                                  ▼
                    ┌─────────────┴─────────────┐
                    ▼             ▼             ▼
                Postgres       Redis           S3
                (+ replica)  (pub/sub +
                              presence)
```

## 15.2 Multi-instance considerations

With more than one Node instance, two clients on the same board may land on different instances. Redis pub/sub bridges them:

```ts
// On receiving an op, after persisting:
await redis.publish(`board:${boardId}`, JSON.stringify(serverOp))

// Every instance subscribes and fans out to its own local sockets:
redis.subscribe(`board:${boardId}`)
redis.on('message', (ch, msg) => roomManager.broadcastLocal(boardId, JSON.parse(msg)))
```

Presence lives in Redis with TTLs: `HSET presence:{boardId} {sessionId} {json}` plus `EXPIRE`, refreshed on every heartbeat, so a crashed instance's sessions age out automatically rather than becoming permanent ghosts.

**For v1, a single instance is acceptable** and simpler. Write the Redis pub/sub path anyway so horizontal scaling is a configuration change rather than a rewrite. Sticky sessions reduce cross-instance chatter but must not be a correctness requirement.

## 15.3 Environment variables

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

## 15.4 Monitoring

| Signal | Alert threshold |
|---|---|
| Error rate | > 1% of requests over 5 min |
| Op persist latency p95 | > 100 ms |
| WebSocket connection failure rate | > 5% |
| Connected sockets | Sudden drop > 50% |
| Postgres connection pool utilization | > 80% |
| Redis memory | > 80% |
| Client `op_rejected` rate | > 0.1% of ops |
| Snapshot job failures | Any |

Log every op rejection with the code, board, actor, and correlation ID. A spike in rejections is the earliest signal that something is wrong with permissions or validation.

---

# 16. Implementation order

Build in this sequence. Each stage is demoable and each depends only on what precedes it.

| Stage | Days | Deliverable | Gate |
|---|---|---|---|
| 1 | 1–2 | Monorepo, shared types, Docker, CI skeleton | `pnpm dev` runs both apps |
| 2 | 3–5 | Canvas layers, viewport, pan, zoom, coordinate conversion | Pan/zoom at 60 fps on an empty board |
| 3 | 6–9 | Pen tool, stroke rendering, simplification, local object store | Draw and see smooth strokes |
| 4 | 10–12 | Select, hit test, move, resize, delete, marquee | All transforms work |
| 5 | 13–15 | Shapes, sticky notes, text overlay editing | All object types render |
| 6 | 16–17 | Local undo/redo with inverse ops | 100-step undo works |
| 7 | 18–20 | Auth (REST), signup, login, guards, refresh rotation | Full auth flow |
| 8 | 21–23 | Boards CRUD, dashboard, op persistence, snapshots | Draw, refresh, still there |
| 9 | 24–27 | WebSocket gateway, rooms, op broadcast, seq ordering | Two windows sync live |
| 10 | 28–30 | Presence: cursors, avatars, remote selection, live strokes | Cursors move smoothly |
| 11 | 31–33 | Reconnection, outbox, gap fill, conflict rules | Chaos tests AT-30–35 pass |
| 12 | 34–36 | Sharing, share links, guest flow, permission enforcement | Guest joins and draws |
| 13 | 37–38 | Export, thumbnails, trash, duplicate | Feature complete |
| 14 | 39–42 | Empty states, error states, responsive, a11y, polish | Definition of Done met throughout |
| 15 | 43–45 | Performance pass, e2e suite, deployment, monitoring | Budgets met, deployed |

**A note on stage 9.** This is where the project either succeeds or turns into a swamp. Do not start it until stages 2–8 are genuinely solid. Debugging a sync bug on top of a shaky renderer means you cannot tell which layer is lying to you, and you will lose days to it.

---

# 17. Appendix — decision log

| # | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| D-1 | Native WebSocket over Socket.IO | Socket.IO, SSE + POST | Learning value; bundle size; the reconnection logic *is* the project |
| D-2 | Server-ordered LWW over CRDT/OT | Yjs, Automerge, custom OT | Sufficient for spatially-separated objects; a library would hide the learning |
| D-3 | Op log over a mutable objects table | Mutable rows + version column | Free replay, idempotency, and audit; snapshots solve the read cost |
| D-4 | Canvas 2D over WebGL | WebGL, SVG | Required by the brief; sufficient to 10k objects; SVG collapses past ~2k nodes |
| D-5 | Multiple canvas layers over one | Single canvas | Cursor movement must not redraw objects. Non-negotiable for performance |
| D-6 | DOM textarea overlay for text editing | Canvas-rendered caret | IME, mobile keyboards, spellcheck, and a11y come free |
| D-7 | Zustand over Redux/Context | Redux Toolkit, Context, Jotai | Readable outside React (essential for the rAF loop); minimal boilerplate |
| D-8 | Fractional z-index over integers | Integer indices with renumbering | Avoids O(n) reorder storms and survives concurrent reordering |
| D-9 | Flat `number[]` for stroke points | `{x,y,p}[]` | ~3× smaller payloads; no per-point allocation |
| D-10 | Local per-user undo over global undo | Global shared history | Global undo lets you revert a teammate's work, which is unacceptable |
| D-11 | Access token in memory, refresh in an httpOnly cookie | Both in localStorage | XSS cannot exfiltrate an in-memory token or read an httpOnly cookie |
| D-12 | Presigned direct-to-S3 uploads | Proxy through Node | Keeps the event loop free during large uploads |
| D-13 | Guests without accounts | Signup required | Persona B abandons at any signup wall; frictionless join is the core of the sharing flow |
| D-14 | Ops persisted before ack | Ack then persist | An acknowledged op must be durable, or the zero-loss guarantee is a lie |
