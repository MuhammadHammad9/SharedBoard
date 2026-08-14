# Product Requirements Document (PRD)
## Project: **CoBoard** — Real-Time Collaborative Whiteboard

| Field | Value |
|---|---|
| Document type | Product Requirements Document |
| Version | 1.0 |
| Status | Approved for build |
| Owner | Engineering Lead |
| Audience | Intern engineering team (frontend + backend), QA, design |
| Related docs | `02-FLOWS.md` (screen & interaction flows), `03-TRD.md` (technical design) |

---

# 0. How to read this document

You are an intern on this project. Read this document **top to bottom once** before you write a single line of code. Then keep it open in a second tab while you work.

Rules for using this doc:

1. **Nothing in this document is optional unless it is explicitly marked `[P2]` or `[Stretch]`.**
2. Every requirement has an ID (e.g. `FR-BOARD-012`). When you open a pull request, reference the requirement IDs it implements. When you file a bug, reference the requirement ID it violates.
3. If a requirement is ambiguous to you, **it is ambiguous, full stop** — do not guess. Post the requirement ID in the team channel and ask. Ambiguity that is silently resolved by a guess is the single largest source of rework on projects like this.
4. Priority labels:
   - `[P0]` — Product does not function without this. Ship-blocking.
   - `[P1]` — Product functions but is embarrassing without this. Ship-blocking for v1.0.
   - `[P2]` — Nice to have. Build only if P0 and P1 are complete and stable.
   - `[Stretch]` — Do not build. Listed so you know we thought about it and deliberately deferred it.

---

# 1. Executive summary

## 1.1 What we are building

CoBoard is a browser-based, real-time collaborative whiteboard. Multiple people open the same board URL and simultaneously draw freehand strokes, place shapes, write text, drop sticky notes, and move things around. Every action any user takes appears on every other user's screen within a few hundred milliseconds. Users see each other's cursors move live, labelled with names.

Think of it as a shared sheet of infinite paper that several people can scribble on at once from different cities.

## 1.2 Why we are building it

This project exists to demonstrate — to ourselves and to anyone evaluating the codebase — that the team can handle the two genuinely hard problems in modern frontend engineering:

1. **Real-time synchronization.** Multiple writers mutating shared state concurrently, over an unreliable network, with no guarantee of message ordering, where every client must converge on an identical final state.
2. **Complex, high-frequency UI state.** A canvas application has selection state, tool state, viewport state, drag state, undo history, and remote-user state all changing tens of times per second, and it must stay at 60fps.

A CRUD app with a form and a table proves neither of these things. This project proves both.

## 1.3 What success looks like

We consider v1.0 successful when a person who has never seen the app can:

- Open a link sent to them by a friend
- Type a display name
- Be drawing on a shared canvas within **10 seconds** of the click
- See their friend's cursor and strokes appear live
- Refresh the page and find everything exactly as they left it
- Lose their wifi for 20 seconds, get it back, and have their offline drawings merge in without losing anything

If all six of those hold, we shipped.

---

# 2. Goals and non-goals

## 2.1 Product goals

| ID | Goal | Success measure |
|---|---|---|
| G-1 | Real-time collaboration that feels instantaneous | p95 end-to-end latency (local input → remote render) under 250 ms on a normal connection |
| G-2 | Zero data loss | No committed operation is ever lost, including across disconnects, refreshes, and server restarts |
| G-3 | Smooth drawing | Local stroke rendering stays at 60 fps with 5,000 objects on the board |
| G-4 | Frictionless entry | A guest can join and draw without creating an account |
| G-5 | Convergence | Any two clients that have received the same set of operations render a pixel-identical board |
| G-6 | Graceful degradation | The app remains usable (locally) while disconnected and self-heals on reconnect |

## 2.2 Explicit non-goals

We are **not** building these. Do not build them. If you find yourself building one, stop.

| Non-goal | Reason |
|---|---|
| Video or voice chat | Enormous scope, WebRTC infrastructure, adds nothing to the thesis of the project |
| Mobile native apps (iOS/Android) | Web only. Responsive web is in scope; native is not |
| Offline-first PWA with full local persistence | We handle short disconnects, not multi-day offline work |
| Rich document editing (Google Docs style) | Different problem domain |
| Payments, billing, subscriptions | No monetization in v1 |
| Real-time collaborative *code* editing | Different data model |
| SSO / SAML / enterprise identity | Email + password + Google OAuth only |
| AI features of any kind | Out of scope |
| Version history with time-travel scrubbing | `[Stretch]` — the op log makes it possible later, but do not build the UI |

## 2.3 The one-sentence scope boundary

> **If a feature does not either (a) let a user put something on the canvas, (b) let a user see what someone else put on the canvas, or (c) let a user get to a canvas — it is out of scope for v1.**

---

# 3. Users and personas

## 3.1 Persona A — "Priya, the organizer" (primary)

- 28, product manager at a 40-person startup.
- Runs remote retrospectives and brainstorms twice a week.
- **Owns** boards. Creates them, names them, invites people, cares that they still exist next month.
- Has an account. Logs in from her laptop.
- **Her jobs:** create a board fast, get a shareable link fast, have the board persist, find it again later.
- **Her fear:** the board disappears or someone wrecks it.
- Uses: sticky notes 70%, text 20%, drawing 10%.

## 3.2 Persona B — "Marcus, the participant" (primary)

- 34, engineer on Priya's team.
- Gets a link in Slack, clicks it, contributes for 45 minutes, never opens it again.
- **Does not want an account.** Any signup wall loses him.
- **His jobs:** join instantly, understand what's happening on the board, add his ideas, not break anything.
- **His fear:** clicking the wrong thing and deleting someone else's work.
- Uses: sticky notes 60%, drawing 30%, text 10%.

## 3.3 Persona C — "Dana, the sketcher" (secondary)

- 24, designer.
- Uses the board like a napkin: fast freehand sketching while talking.
- Cares deeply about **input latency and stroke quality**. A laggy or jagged line is a dealbreaker.
- Uses a trackpad, sometimes a drawing tablet with pen pressure.
- **Her jobs:** draw smooth lines fast, undo mistakes instantly, pan and zoom fluidly.

## 3.4 Persona D — "the reviewer" (meta-persona)

Whoever is evaluating this codebase. They will open the network tab, throttle the connection, open two windows side by side, and try to break the sync. **Build as if they are always watching**, because the entire point of this project is that they will be.

---

# 4. Core concepts and vocabulary

Everyone on this team uses these words to mean exactly these things. Using them loosely causes bugs.

| Term | Definition |
|---|---|
| **Board** | A single infinite canvas with a unique ID and URL. The top-level container. |
| **Object** | Anything on the board: a stroke, a rectangle, a sticky note, a text block, an image. Has an ID, a type, a geometry, and style properties. Also called a "shape" or "element" in code — **we standardize on `object`**. |
| **Operation (op)** | An atomic, immutable change to the board: create object, update object, delete object. Ops are what travel over the wire and what get stored in the log. |
| **Op log** | The append-only, ordered list of every operation ever applied to a board. The board's state is a pure function of its op log. This is the source of truth. |
| **Snapshot** | A materialized board state at a given op sequence number, cached so we don't replay 50,000 ops on every load. |
| **Session** | One user's active connection to one board. Ends on disconnect. |
| **Presence** | Ephemeral, non-persisted data about a live session: cursor position, current selection, viewport, name, colour. Presence is **never** written to the database. |
| **Viewport** | The rectangle of infinite canvas currently visible, defined by pan offset `(x, y)` and `zoom` scale. |
| **Canvas coordinates** | The board's own infinite coordinate space. Object positions are always stored in canvas coordinates. |
| **Screen coordinates** | Pixel positions in the browser window. Derived from canvas coordinates via the viewport transform. **Never store screen coordinates.** |
| **Local echo / optimistic apply** | Applying an op to your own screen immediately, before the server confirms it. |
| **Convergence** | The property that all clients end up in the same state given the same set of ops, regardless of arrival order. |
| **Room** | The server-side grouping of all sessions currently connected to one board. |

---

# 5. Feature requirements

## 5.1 Authentication & identity

### FR-AUTH-001 `[P0]` — Email + password registration
A visitor can create an account with email, password, and display name.
- Email must be unique, case-insensitive, and validated against RFC 5322 (a pragmatic subset is fine).
- Password minimum 8 characters. Must contain at least one letter and one number. Maximum 128 characters (to bound bcrypt cost).
- Display name: 1–40 characters, trimmed, no leading/trailing whitespace, must not be empty after trim.
- On success the user is authenticated immediately and lands on the Dashboard. **We do not block on email verification.**

### FR-AUTH-002 `[P0]` — Email + password login
- Failed login returns a **generic** error: "Email or password is incorrect." Never reveal whether the email exists.
- After 5 failed attempts for one email within 15 minutes, further attempts for that email are rejected for 15 minutes with a clear message and a countdown.

### FR-AUTH-003 `[P1]` — Google OAuth sign-in
- "Continue with Google" on both signup and login screens.
- If the Google email matches an existing password account, **link them** — do not create a duplicate.

### FR-AUTH-004 `[P1]` — Password reset
- "Forgot password" → enter email → always show the same confirmation screen regardless of whether the email exists.
- Reset token is single-use and expires in 60 minutes.
- Resetting the password invalidates all existing sessions for that user.

### FR-AUTH-005 `[P0]` — Session persistence
- A logged-in user stays logged in across browser restarts for 30 days.
- Sessions are refreshed silently; the user never sees a login screen mid-work.
- If a session expires while a board is open, the user is **not** kicked out of the board — see `FR-BOARD-041`.

### FR-AUTH-006 `[P0]` — Guest identity
- A user without an account who opens a shared board link is a **guest**.
- A guest must supply a display name (1–40 chars) before entering the board. This is the only friction permitted.
- Guest identity is stored in `localStorage` under `coboard.guest` as `{ id, name, colour }` so that returning to the same board reuses the same identity and colour.
- Guests **cannot**: create boards, see a dashboard, change board settings, delete the board, or manage members.
- Guests **can**: draw, edit, move, delete objects (subject to the permission level of the link), and see presence.

### FR-AUTH-007 `[P1]` — Logout
- Logout clears the session, clears in-memory board caches, and returns to the landing page.
- If the user is in a board when they log out, disconnect the socket cleanly first.

---

## 5.2 Board management

### FR-BOARD-001 `[P0]` — Create board
- From the Dashboard, "New board" creates a board and navigates straight into it. **No intermediate naming dialog** — speed matters. Default name is `Untitled board`.
- The creator is the board **Owner**.

### FR-BOARD-002 `[P0]` — Board list (Dashboard)
- Shows all boards the user owns or has been added to.
- Each card shows: thumbnail, name, last-edited relative timestamp ("2 hours ago"), owner avatar, and up to 4 collaborator avatars with a "+N" overflow.
- Default sort: last edited, descending.
- Sort options: last edited, date created, name A→Z.
- Filter tabs: **All**, **Owned by me**, **Shared with me**, **Starred**.

### FR-BOARD-003 `[P1]` — Board thumbnails
- A thumbnail is regenerated on the client when a board session ends or every 5 minutes of active editing, whichever comes first.
- Rendered as a 640×400 JPEG at 0.7 quality, containing the bounding box of all objects with 5% padding.
- Empty boards get a static placeholder graphic, not a blank white rectangle.

### FR-BOARD-004 `[P0]` — Rename board
- Inline rename from the dashboard card menu, and from the board header by clicking the title.
- 1–80 characters. Empty name reverts to the previous value.
- The rename broadcasts to everyone currently in the board.

### FR-BOARD-005 `[P0]` — Delete board (soft)
- Only the Owner can delete.
- Requires a confirmation modal that states the board name and that it will be recoverable for 30 days.
- Deleted boards go to **Trash**, are removed from all members' dashboards, and **all connected sessions are ejected** with an explanatory screen.

### FR-BOARD-006 `[P1]` — Trash and restore
- Trash view lists soft-deleted boards with days-remaining.
- Restore returns the board to the dashboard with full content and membership intact.
- Permanent delete requires typing the board name to confirm.

### FR-BOARD-007 `[P1]` — Duplicate board
- Creates a copy named `<name> (copy)`, owned by the person duplicating, with all objects but **no members and no share links**.

### FR-BOARD-008 `[P2]` — Star / favourite
- Toggle from the dashboard card. Starred boards pin to the top of the "Starred" tab.

### FR-BOARD-009 `[P2]` — Templates
- On "New board", an optional template picker: Blank, Retrospective (3 columns), Kanban (4 columns), Mind map (central node), Flowchart starter.
- A template is just a predefined set of objects inserted at creation time.

---

## 5.3 Sharing & permissions

### FR-SHARE-001 `[P0]` — Permission model
Exactly four roles. No others.

| Role | Can view | Can edit objects | Can invite | Can change board settings | Can delete board |
|---|:--:|:--:|:--:|:--:|:--:|
| **Owner** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Editor** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Commenter** `[P2]` | ✅ | ❌ (comments only) | ❌ | ❌ | ❌ |
| **Viewer** | ✅ | ❌ | ❌ | ❌ | ❌ |

- A board has exactly **one** Owner.
- Owner can transfer ownership `[P2]`.

### FR-SHARE-002 `[P0]` — Share link
- Owner generates a link with a chosen access level: **Anyone with the link can edit** / **can view**, or **Off (invite only)**.
- Link contains an unguessable token (≥128 bits of entropy), not the raw board ID.
- Copy-to-clipboard button with a "Copied!" confirmation toast.

### FR-SHARE-003 `[P1]` — Revoke and regenerate link
- Revoking invalidates the old link immediately. Anyone currently connected via that link is ejected on their next heartbeat with an "Access removed" screen.

### FR-SHARE-004 `[P1]` — Invite by email
- Owner enters emails, chooses a role, sends invites.
- Registered users are added directly and see the board on their dashboard.
- Unregistered emails receive an invite link; on signup they are auto-added.

### FR-SHARE-005 `[P0]` — Access denial
- A user opening a board they cannot access sees a dedicated "You don't have access" screen with the board name hidden, a "Request access" button `[P2]`, and a link back to their dashboard.

### FR-SHARE-006 `[P0]` — Viewer mode enforcement
- Viewers see the canvas and all presence, but the toolbar is replaced with a read-only badge.
- Viewer edit attempts are blocked **on the client and rejected on the server**. Client-side blocking alone is not acceptable.

---

## 5.4 Canvas — objects and tools

### FR-CANVAS-001 `[P0]` — Infinite canvas
- The canvas has no boundaries. Objects may exist at any coordinate.
- Practical bound: coordinates are clamped to ±1,000,000 to avoid floating-point precision loss.

### FR-CANVAS-002 `[P0]` — Pan
- Space + drag, middle-mouse drag, two-finger trackpad scroll, or the Hand tool.
- Panning is buttery: it must not re-render objects, only translate the viewport transform.

### FR-CANVAS-003 `[P0]` — Zoom
- Ctrl/Cmd + scroll wheel, pinch on trackpad, or zoom controls in the bottom-right.
- Range: **10% to 500%**. Clamped hard at both ends.
- Zoom is anchored at the **pointer position**, not the viewport centre. This is non-negotiable; centre-anchored zoom feels broken.
- Zoom controls: `−`, percentage display (click to reset to 100%), `+`, and "Zoom to fit".

### FR-CANVAS-004 `[P0]` — Select tool (default tool, `V`)
- Click an object to select it.
- Shift+click to add/remove from selection.
- Drag on empty canvas draws a **marquee rectangle**; objects fully contained are selected on release.
- Click empty canvas to deselect all.
- Selected objects show a bounding box with 8 resize handles and 1 rotate handle above the top edge.

### FR-CANVAS-005 `[P0]` — Pen / freehand tool (`P`)
- Pointer down starts a stroke; pointer move appends points; pointer up commits it as a single object.
- Points are **smoothed and simplified** before commit (see TRD §7.3). A 3-second scribble must not produce 400 raw points in the database.
- Configurable: colour (10-swatch palette + custom), thickness (1–24 px, 5 presets), opacity (10–100%).
- Pressure sensitivity from `PointerEvent.pressure` when available `[P1]`.

### FR-CANVAS-006 `[P0]` — Eraser tool (`E`)
- **Object eraser** (default): hovering with the eraser highlights objects in red; pointer-down-and-drag deletes every object touched.
- Deletion is a normal op and is fully undoable.
- `[P2]` Pixel eraser that splits strokes is explicitly out of scope.

### FR-CANVAS-007 `[P0]` — Shape tools (`R` rectangle, `O` ellipse, `L` line, `A` arrow)
- Click-drag to define the shape's bounding box.
- Hold **Shift** to constrain: square, circle, or 45°-snapped line/arrow.
- Hold **Alt/Option** to draw from the centre outward.
- Properties: stroke colour, stroke width, fill colour (including "none"), opacity, corner radius (rectangles only).

### FR-CANVAS-008 `[P0]` — Sticky note tool (`N`)
- Click to place a fixed 200×200 note; or drag to define a custom size.
- 8 preset colours: yellow, orange, pink, red, purple, blue, green, grey.
- Immediately enters text-edit mode on placement — the user should be able to click and type without a second action.
- Text auto-shrinks from 16 px down to 10 px to fit; beyond that the note scrolls internally and shows a fade indicator.
- Text is centred vertically and horizontally by default.

### FR-CANVAS-009 `[P0]` — Text tool (`T`)
- Click to place a text cursor; type directly on canvas.
- Properties: font size (8–128), colour, bold, italic, alignment (left/centre/right).
- Font family: system sans-serif stack only in v1. **No font picker.**
- An empty text object is discarded on blur — never persist empty text.

### FR-CANVAS-010 `[P1]` — Image upload
- Drag-and-drop a file onto the canvas, or paste from clipboard, or use the toolbar image button.
- Accepted: PNG, JPEG, GIF, WebP, SVG. Max **10 MB** per file.
- Images are uploaded to object storage; the op stores a URL, never base64.
- While uploading, show a placeholder rectangle with a progress ring at the drop position.
- Failed uploads show an inline error on the placeholder with a retry button.

### FR-CANVAS-011 `[P0]` — Move objects
- Drag a selected object (or multi-selection) to move it.
- Arrow keys nudge by 1 px; Shift+arrow nudges by 10 px.
- While dragging, broadcast **throttled** intermediate positions so remote users see the movement, then commit the final position on release. Intermediate positions are presence-like and are not written to the op log.

### FR-CANVAS-012 `[P0]` — Resize objects
- Corner handles resize freely; Shift preserves aspect ratio; Alt resizes from centre.
- Edge handles resize one axis.
- Minimum object size 8×8 px in canvas coordinates.
- Text and sticky note resizing reflows text rather than scaling glyphs.
- Freehand strokes scale their point geometry proportionally.

### FR-CANVAS-013 `[P1]` — Rotate objects
- Rotate handle above the bounding box. Shift snaps to 15° increments.
- Rotation stored in degrees, 0–359.99, normalized.

### FR-CANVAS-014 `[P0]` — Delete objects
- `Delete` or `Backspace` deletes the selection.
- Deleting is undoable.

### FR-CANVAS-015 `[P0]` — Copy / cut / paste / duplicate
- `Cmd/Ctrl+C`, `X`, `V`, and `Cmd/Ctrl+D` for duplicate.
- Paste places objects at the pointer position; duplicate offsets by +16, +16 canvas px.
- Pasted objects get **new IDs**. Never reuse an ID.
- Cross-board and cross-tab paste works via a serialized JSON payload on the system clipboard.

### FR-CANVAS-016 `[P1]` — Z-order
- Bring to front, bring forward, send backward, send to back, from the context menu and via `]`, `Cmd+]`, `[`, `Cmd+[`.
- Z-order is a fractional index (see TRD §6.4), not an array position.

### FR-CANVAS-017 `[P1]` — Grouping `[P2]`
- Deferred. Do not build.

### FR-CANVAS-018 `[P0]` — Undo / redo
- `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z`.
- **Undo is per-user and local.** Undoing must never revert another user's work. This is the most commonly botched requirement in collaborative editors — read TRD §8 carefully.
- History depth: 100 entries per session.
- Undo history is cleared on page reload (we do not persist it).
- A user who undoes an operation on an object that another user has since deleted gets a **no-op**, not a crash and not a resurrection.

### FR-CANVAS-019 `[P1]` — Context menu
- Right-click on an object: Duplicate, Copy, Bring to front, Send to back, Change colour, Delete.
- Right-click on empty canvas: Paste, Select all, Zoom to fit.

### FR-CANVAS-020 `[P1]` — Alignment guides
- When dragging, show pink snap guides when an edge or centre aligns with another object's edge or centre within 6 screen px, and snap to it.
- Hold `Ctrl` to temporarily disable snapping.

### FR-CANVAS-021 `[P2]` — Grid and snap-to-grid
- Toggleable dot grid at 20 canvas px. Optional snap.

### FR-CANVAS-022 `[P0]` — Select all / deselect
- `Cmd/Ctrl+A` selects all objects on the board (not just visible ones).
- `Escape` deselects and returns to the Select tool.

---

## 5.5 Real-time collaboration

### FR-RT-001 `[P0]` — Live object sync
- Any create, update, or delete performed by any user appears on all other connected clients.
- **Target p95 latency: 250 ms.** Hard ceiling: 500 ms.

### FR-RT-002 `[P0]` — Optimistic local application
- The acting user's own changes render **immediately**, before server acknowledgement. There must be zero perceptible input lag on drawing.
- If the server rejects an op, roll it back locally and show a non-blocking toast.

### FR-RT-003 `[P0]` — Live cursors
- Every other connected user's cursor is rendered as a coloured pointer with their display name in a pill beside it.
- Cursor updates are throttled to **20 Hz** on send and interpolated on receive for smoothness.
- A cursor that has not updated in 5 seconds fades to 40% opacity; at 15 seconds it is hidden.
- Cursors are rendered in a separate overlay layer, never on the main object canvas.

### FR-RT-004 `[P0]` — Presence list
- The board header shows stacked avatars of everyone currently connected, max 5 visible plus "+N".
- Hover shows name and role. Click "follow" `[P2]`.
- Each user is assigned a colour from a fixed 12-colour palette on join, chosen to minimize collision within the room.

### FR-RT-005 `[P1]` — Remote selection indicators
- When another user has an object selected, that object shows a thin outline in that user's colour with their name label.

### FR-RT-006 `[P1]` — Live in-progress strokes
- While a remote user is mid-stroke, transmit partial stroke points (throttled to 20 Hz) so the line appears to be drawn live rather than popping in complete on pointer-up.
- Partial strokes live in the presence layer. Only the final committed stroke enters the op log.

### FR-RT-007 `[P0]` — Concurrent edit resolution
- Two users editing **different** objects: both changes apply. Always.
- Two users editing **different properties** of the same object (e.g. one moves it, one recolours it): both changes apply.
- Two users editing **the same property** of the same object: last-writer-wins by server sequence number. The loser sees their value replaced. No error is shown; this is expected behaviour.
- One user deletes an object while another moves it: **delete wins.** The object stays deleted. The mover's update is dropped silently.

### FR-RT-008 `[P0]` — Join / leave notifications
- A subtle toast in the bottom-left: "Marcus joined" / "Marcus left". Auto-dismiss after 3 seconds. Maximum 3 stacked; older ones collapse.

### FR-RT-009 `[P0]` — Connection status indicator
The board header shows exactly one of:

| State | Indicator | Meaning |
|---|---|---|
| Connected | Green dot, no text | Everything normal |
| Connecting | Amber pulsing dot + "Connecting…" | Initial connect or reconnect in progress |
| Reconnecting | Amber + "Reconnecting… (attempt N)" | Lost connection, retrying with backoff |
| Offline | Red + "Offline — changes saved locally" | Browser reports offline, or all retries exhausted |
| Syncing | Blue + "Syncing N changes…" | Reconnected, flushing the outbox |

### FR-RT-010 `[P0]` — Offline editing and reconnection
- On disconnect, the user can keep working. All ops queue in a local **outbox**.
- On reconnect, the client sends its last known sequence number, receives the ops it missed, replays them, then flushes the outbox.
- Nothing is lost. The user's queued work merges with everything that happened while they were away.
- If the outbox exceeds 500 ops or the disconnect exceeds 10 minutes, show a warning banner recommending a refresh.

### FR-RT-011 `[P1]` — Room capacity
- Soft limit of 50 concurrent users per board. Beyond that, new joins are admitted as viewers with a notice, or rejected `[P2]`.

### FR-RT-012 `[P0]` — Persistence guarantee
- An op is only acknowledged to the client after it is durably persisted. A client that receives an ack can safely drop the op from its outbox.

---

## 5.6 Comments `[P2]`

### FR-COMMENT-001 `[P2]`
- Pin a comment thread to a canvas coordinate or to an object.
- Threads support replies and resolve.
- Deferred entirely from v1. Listed for completeness.

---

## 5.7 Export

### FR-EXPORT-001 `[P1]` — Export as PNG
- Export the whole board or the current selection.
- Options: transparent background toggle, 1× / 2× scale, padding.

### FR-EXPORT-002 `[P2]` — Export as SVG
### FR-EXPORT-003 `[P2]` — Export board JSON (for debugging and re-import)

---

## 5.8 Settings

### FR-SET-001 `[P1]` — Profile settings
- Change display name, avatar, and password. Delete account (with a typed confirmation).

### FR-SET-002 `[P2]` — Appearance
- Light / dark / system theme for the app chrome. The canvas itself stays light in v1.

### FR-SET-003 `[P1]` — Keyboard shortcuts reference
- A modal listing every shortcut, opened with `?`.

---

# 6. Screen inventory

Full flows live in `02-FLOWS.md`. This is the authoritative list of screens that must exist.

| # | Screen | Route | Auth required | Priority |
|---|---|---|---|---|
| S-01 | Landing page | `/` | No | P1 |
| S-02 | Sign up | `/signup` | No | P0 |
| S-03 | Log in | `/login` | No | P0 |
| S-04 | Forgot password | `/forgot-password` | No | P1 |
| S-05 | Reset password | `/reset-password?token=` | No | P1 |
| S-06 | OAuth callback | `/auth/callback` | No | P1 |
| S-07 | Dashboard | `/dashboard` | Yes | P0 |
| S-08 | Trash | `/dashboard/trash` | Yes | P1 |
| S-09 | Template picker (modal) | `/dashboard` + modal | Yes | P2 |
| S-10 | **Board canvas** | `/board/:boardId` | Conditional | P0 |
| S-11 | Guest name entry | `/join/:token` | No | P0 |
| S-12 | Share modal | `/board/:boardId` + modal | Yes | P0 |
| S-13 | Board settings modal | `/board/:boardId` + modal | Yes (owner) | P1 |
| S-14 | Export modal | `/board/:boardId` + modal | Conditional | P1 |
| S-15 | Shortcuts modal | any + modal | No | P1 |
| S-16 | Profile settings | `/settings` | Yes | P1 |
| S-17 | Access denied | `/board/:boardId` (403 state) | — | P0 |
| S-18 | Board not found | `/board/:boardId` (404 state) | — | P0 |
| S-19 | Board deleted (ejected) | in-board full-screen state | — | P0 |
| S-20 | Generic 404 | `*` | No | P1 |
| S-21 | Error boundary / crash screen | any | — | P0 |
| S-22 | Onboarding tour overlay | `/board/:boardId` first visit | — | P2 |

---

# 7. Non-functional requirements

## 7.1 Performance budgets

These are **budgets, not aspirations.** A PR that regresses a budget does not merge.

| Metric | Budget | Measured how |
|---|---|---|
| Landing page LCP | ≤ 1.5 s on 4G | Lighthouse |
| Dashboard interactive | ≤ 2.0 s | Lighthouse |
| Board first paint (500 objects) | ≤ 1.5 s from navigation | Custom perf mark |
| Board first paint (5,000 objects) | ≤ 3.0 s | Custom perf mark |
| Drawing frame rate | ≥ 55 fps sustained with 5,000 objects | Chrome perf panel |
| Pan/zoom frame rate | ≥ 55 fps | Chrome perf panel |
| Input-to-local-pixel latency | ≤ 16 ms | Manual + instrumented |
| Local-input-to-remote-render (p95) | ≤ 250 ms | Instrumented, same-region |
| Cursor update rate | 20 Hz send, interpolated render | Code review |
| Initial JS bundle (gzipped) | ≤ 250 KB | Bundle analyzer, CI gate |
| Board route chunk (gzipped) | ≤ 200 KB | Bundle analyzer |
| Memory with 5,000 objects | ≤ 300 MB heap | Chrome memory profiler |
| WebSocket message size (typical op) | ≤ 2 KB | Network tab |

## 7.2 Scalability targets (v1)

- 1,000 total registered users
- 50 concurrent users per board
- 200 concurrent boards
- 50,000 objects maximum per board (with a soft warning at 10,000)
- 100 ops/second sustained per board

## 7.3 Reliability

- Target uptime 99.5% for v1.
- **Zero committed-op loss.** This is stricter than uptime: the system may be briefly unavailable, but it must never lose an acknowledged operation.
- Server restart must not lose in-flight ops (they are persisted before ack).
- Automated daily database backups with a tested restore procedure.

## 7.4 Security

| Requirement | Detail |
|---|---|
| Transport | HTTPS and WSS only. HTTP redirects to HTTPS. HSTS enabled. |
| Passwords | bcrypt, cost factor 12. Never logged, never returned by any endpoint. |
| Tokens | Access token in memory (15 min), refresh token in `httpOnly`, `Secure`, `SameSite=Lax` cookie (30 days), rotated on use. |
| Authorization | Enforced **server-side on every socket message and every HTTP request.** Client-side checks are UX only. |
| Share tokens | ≥128 bits from a CSPRNG. Never sequential. |
| Input validation | Every inbound payload validated against a schema at the boundary. Reject, do not coerce. |
| XSS | All user text rendered as text, never as HTML. Sticky note and text content is drawn to canvas, which is inherently safe, but board names and display names appear in the DOM and must be escaped by React's default behaviour — **never `dangerouslySetInnerHTML`.** |
| SVG uploads | Sanitized server-side (strip `<script>`, event handlers, external refs) or served from a separate origin. |
| Rate limits | Auth: 5/15 min per email + 20/15 min per IP. Ops: 100/sec per socket. Uploads: 20/hour per user. |
| CORS | Explicit allow-list of our own origins. No wildcards. |
| Socket auth | The connection is authenticated during the handshake. An unauthenticated socket is closed, never allowed to linger. |
| Dependency scanning | `npm audit` in CI; high/critical vulnerabilities block the build. |
| Secrets | Environment variables only. `.env` is git-ignored and there is a committed `.env.example`. A secret in a commit means rotating the secret, not just reverting the commit. |

## 7.5 Accessibility `[P1]`

The canvas itself cannot be made fully accessible with reasonable effort, and we accept that. Everything around it must be.

- All non-canvas UI is keyboard navigable with a visible focus ring.
- All controls have accessible names. Icon-only buttons need `aria-label`.
- Colour contrast ≥ 4.5:1 for text, ≥ 3:1 for UI boundaries.
- Modals trap focus, close on `Escape`, and restore focus to the trigger.
- Toasts are announced via `aria-live="polite"`.
- The canvas has a text alternative: `role="img"` with a summary like "Whiteboard with 24 objects".
- Never convey information by colour alone. Presence colours are always paired with a name.
- Respect `prefers-reduced-motion`.

## 7.6 Browser support

| Browser | Version | Support level |
|---|---|---|
| Chrome / Edge | Last 2 | Full |
| Firefox | Last 2 | Full |
| Safari (macOS) | 16+ | Full |
| Safari (iOS) | 16+ | Touch-adapted, view + basic edit |
| Chrome (Android) | Last 2 | Touch-adapted, view + basic edit |
| Internet Explorer | any | **Not supported.** Show an unsupported-browser screen. |

## 7.7 Responsive behaviour

| Breakpoint | Behaviour |
|---|---|
| ≥ 1280 px | Full layout: left toolbar, right properties panel, header |
| 1024–1279 px | Properties panel collapses to a popover triggered by selection |
| 768–1023 px | Toolbar becomes a bottom bar; dashboard grid drops to 2 columns |
| < 768 px | Mobile: bottom toolbar with the 5 core tools, pinch/pan, no properties panel, no multi-select marquee. Dashboard is a single-column list. |

---

# 8. Content, copy, and error messages

Consistency in copy is a feature. Use exactly these strings.

## 8.1 Tone rules
- Second person, present tense. "You don't have access", not "Access is denied to this user."
- Never blame the user. "That email or password didn't match", not "You entered an invalid password."
- Every error tells the user **what to do next**.
- No exclamation marks except in "Copied!" and celebratory empty states.
- Never expose internal identifiers, stack traces, or error codes to the user. Log them; show a friendly message with a short correlation ID.

## 8.2 Canonical error strings

| Situation | Message | Action offered |
|---|---|---|
| Wrong credentials | "That email or password didn't match. Try again." | — |
| Rate limited (login) | "Too many attempts. Try again in {N} minutes." | — |
| Email already registered | "An account already exists for this email." | "Log in instead" |
| Weak password | "Password needs at least 8 characters, including a letter and a number." | — |
| No board access | "You don't have access to this board." | "Ask the owner for access" / "Back to dashboard" |
| Board not found | "This board doesn't exist, or it was deleted." | "Back to dashboard" |
| Board deleted while open | "The owner deleted this board." | "Back to dashboard" |
| Access revoked while open | "Your access to this board was removed." | "Back to dashboard" |
| Disconnected | "Offline — your changes are saved locally and will sync when you're back." | "Retry now" |
| Reconnecting | "Reconnecting… (attempt {N})" | — |
| Syncing | "Syncing {N} changes…" | — |
| Op rejected | "That change couldn't be saved." | "Undo" |
| Upload too large | "Images must be under 10 MB." | — |
| Unsupported file | "We support PNG, JPG, GIF, WebP, and SVG." | — |
| Upload failed | "Upload failed." | "Retry" / "Remove" |
| Board too large | "This board is getting large. Consider splitting it up." | "Dismiss" |
| Generic server error | "Something went wrong on our end. We're looking into it." + `Ref: {8-char id}` | "Retry" |
| Unsupported browser | "CoBoard needs a modern browser. Try Chrome, Firefox, Edge, or Safari." | — |

## 8.3 Empty states

| Screen | Illustration + headline | Body | CTA |
|---|---|---|---|
| Dashboard, no boards | "Nothing here yet" | "Create your first board and invite your team." | "New board" |
| Dashboard, filter empty | "No boards match that filter" | — | "Clear filter" |
| Trash empty | "Trash is empty" | "Deleted boards appear here for 30 days." | — |
| Board with no objects | Faint centred hint: "Pick a tool and start drawing" with an arrow pointing at the toolbar. Fades out permanently after the first object is created. | — | — |
| Search no results | "No boards found for '{query}'" | — | "Clear search" |

---

# 9. Analytics and instrumentation `[P1]`

Track these events. Names are `snake_case`, past tense.

| Event | Properties |
|---|---|
| `account_created` | `method` (password/google) |
| `logged_in` | `method` |
| `board_created` | `template`, `from` (dashboard/empty_state) |
| `board_opened` | `board_id`, `role`, `object_count`, `load_ms` |
| `board_joined_as_guest` | `board_id` |
| `object_created` | `type`, `board_id` |
| `tool_selected` | `tool`, `via` (click/shortcut) |
| `share_link_created` | `access_level` |
| `share_link_copied` | — |
| `export_completed` | `format`, `scope` |
| `socket_disconnected` | `reason`, `session_duration_ms` |
| `socket_reconnected` | `attempts`, `downtime_ms`, `outbox_size` |
| `op_rejected` | `op_type`, `reason` |
| `client_error` | `message`, `component`, `correlation_id` |

Operational metrics (server-side): connected sockets, ops/sec, op persist latency p50/p95/p99, broadcast fan-out latency, room count, snapshot generation time, error rate by endpoint.

---

# 10. Milestones and acceptance

## Milestone 1 — "It draws" (Week 1–2)
Single-user canvas. No server, no accounts. Local state only.
- **Done when:** pen, rectangle, ellipse, sticky note, text, select, move, resize, delete, undo/redo, pan, zoom all work at 60 fps with 1,000 objects. Refreshing loses everything, and that is fine at this stage.

## Milestone 2 — "It persists" (Week 3)
Auth, dashboard, board CRUD, REST persistence of the op log.
- **Done when:** a user can sign up, create a board, draw, refresh, and see their work.

## Milestone 3 — "It syncs" (Week 4–5)
WebSocket layer, op broadcast, presence, cursors.
- **Done when:** two browser windows show each other's strokes and cursors live, and both converge to identical state.

## Milestone 4 — "It survives" (Week 6)
Reconnection, outbox, op replay, conflict rules, permissions enforcement.
- **Done when:** the chaos tests in §11.4 pass.

## Milestone 5 — "It's finished" (Week 7–8)
Sharing UI, guest flow, export, empty states, error states, responsive, accessibility, polish.
- **Done when:** every P0 and P1 requirement in this document has a passing test and a reviewed PR.

## 10.1 Definition of Done (per feature)

A feature is done when **all** of the following are true. Not most. All.

1. Implements every acceptance criterion of its requirement ID.
2. Handles loading, empty, error, and offline states.
3. Keyboard accessible with visible focus.
4. Works at every breakpoint in §7.7.
5. Unit tests for logic; integration test for the happy path and at least one failure path.
6. No new console errors or warnings.
7. No TypeScript `any` introduced without a comment explaining why.
8. Meets the relevant performance budget.
9. Copy matches §8 exactly.
10. Reviewed and approved by one other person.
11. Server-side authorization enforced where applicable.

---

# 11. Acceptance test scenarios

These are the scenarios QA will run. Write them as automated tests where you can.

## 11.1 Core collaboration

| ID | Scenario | Expected |
|---|---|---|
| AT-01 | Two windows, A draws a stroke | Appears in B within 250 ms |
| AT-02 | A and B draw simultaneously for 30 s | Both boards identical; object counts match exactly |
| AT-03 | A moves object X while B recolours object X | Final state has both the new position and the new colour |
| AT-04 | A deletes object X while B moves it | Object is gone on both. No error, no zombie object |
| AT-05 | A and B both set object X's fill within 50 ms | Both converge to the same colour (the later server-sequenced one) |
| AT-06 | B joins mid-session | B sees the complete existing board and all live cursors |
| AT-07 | A closes the tab | A's cursor and avatar disappear from B within 5 s |
| AT-08 | 5 users draw simultaneously for 2 minutes | All 5 converge; no dropped ops; frame rate holds |

## 11.2 Persistence

| ID | Scenario | Expected |
|---|---|---|
| AT-10 | Draw, refresh | Everything is still there, in the same position and z-order |
| AT-11 | Draw, close browser, reopen tomorrow | Everything is still there |
| AT-12 | Restart the server mid-session | Clients reconnect automatically; no ops lost |
| AT-13 | Board with 5,000 objects | Loads in under 3 s and is interactive |

## 11.3 Permissions

| ID | Scenario | Expected |
|---|---|---|
| AT-20 | Viewer tries to draw | Toolbar disabled; a forged socket op is rejected server-side |
| AT-21 | Non-member opens the board URL | Access-denied screen |
| AT-22 | Owner revokes a link while a guest is drawing | Guest is ejected within 10 s with the correct message |
| AT-23 | Owner deletes the board with 3 users connected | All 3 see the "board deleted" screen |
| AT-24 | Editor tries to call the delete-board endpoint directly | 403 |

## 11.4 Network chaos

| ID | Scenario | Expected |
|---|---|---|
| AT-30 | Kill wifi, draw 10 strokes, restore wifi | All 10 strokes appear for everyone; nothing duplicated |
| AT-31 | Both A and B go offline, both draw, both return | Both sets of work merge; both converge |
| AT-32 | Throttle to 3G with 400 ms latency | App remains usable; local drawing stays instant |
| AT-33 | Kill the connection mid-stroke | The partial stroke either commits fully on reconnect or does not exist. Never a half-stroke |
| AT-34 | 30 rapid disconnect/reconnect cycles | No duplicate ops, no memory leak, no zombie sockets server-side |
| AT-35 | Send a malformed op via the console | Server rejects it and does not crash; other clients are unaffected |

## 11.5 Undo

| ID | Scenario | Expected |
|---|---|---|
| AT-40 | A draws, B draws, A undoes | Only A's stroke disappears. B's stroke is untouched |
| AT-41 | A moves an object, B deletes it, A undoes | No-op. No crash, no resurrection |
| AT-42 | A performs 10 actions and undoes 10 times | The board returns to A's starting state |
| AT-43 | A undoes 5 then redoes 5 | Identical to before the undos |
| AT-44 | A undoes, then performs a new action, then presses redo | Redo does nothing (the redo stack was cleared) |

---

# 12. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Conflict resolution is subtly wrong; clients diverge | High | Critical | Build a convergence test harness in week 4. Keep the resolution rules dead simple (§FR-RT-007). Add a debug panel showing the op count and a state hash per client |
| R-2 | Canvas performance collapses past a few thousand objects | High | High | Layered canvases, viewport culling, dirty-rect rendering, and a seeded 10k-object stress board committed to the repo from week 1 |
| R-3 | Per-user undo interacts badly with remote ops | High | High | Implement the inverse-op model in TRD §8 exactly. Do not invent a variant |
| R-4 | Interns build the fun canvas parts and skip error/empty states | Very High | Medium | The Definition of Done includes them. Reviewers reject PRs without them |
| R-5 | Scope creep (someone builds comments, or a font picker) | High | Medium | §2.2 is binding. New scope goes to the backlog, not into the sprint |
| R-6 | WebSocket reconnection has an edge case that loses ops | Medium | Critical | Sequence numbers + client-generated op IDs + server-side idempotency. Chaos tests AT-30–AT-35 are ship-blocking |
| R-7 | Coordinate-space confusion (screen vs canvas) | Very High | Medium | Two branded TypeScript types, `ScreenPoint` and `CanvasPoint`, so the compiler catches mixups |
| R-8 | Memory leaks from event listeners and socket handlers | Medium | Medium | Every `useEffect` returns a cleanup. Profile heap after 30 minutes of use in week 6 |
| R-9 | Everyone works on the canvas file at once; merge hell | Medium | Medium | Strict module boundaries defined in the TRD. Owners assigned per module |

---

# 13. Open questions

| # | Question | Owner | Needed by |
|---|---|---|---|
| Q-1 | Do guests persist as board members after leaving, or vanish entirely? | Product | Milestone 3 |
| Q-2 | Does a board have a hard object cap, or only a soft warning? | Eng lead | Milestone 4 |
| Q-3 | Do we ship dark mode for the canvas or only the chrome? | Design | Milestone 5 |
| Q-4 | Is the 30-day trash retention configurable per board? | Product | Milestone 5 |

---

# 14. Appendix A — Complete keyboard shortcut map

| Shortcut | Action | Context |
|---|---|---|
| `V` | Select tool | Board |
| `H` | Hand / pan tool | Board |
| `P` | Pen tool | Board |
| `E` | Eraser tool | Board |
| `R` | Rectangle | Board |
| `O` | Ellipse | Board |
| `L` | Line | Board |
| `A` | Arrow | Board |
| `N` | Sticky note | Board |
| `T` | Text | Board |
| `Space` (hold) | Temporary pan | Board |
| `Cmd/Ctrl + Z` | Undo | Board |
| `Cmd/Ctrl + Shift + Z` | Redo | Board |
| `Cmd/Ctrl + C` | Copy | Board |
| `Cmd/Ctrl + X` | Cut | Board |
| `Cmd/Ctrl + V` | Paste | Board |
| `Cmd/Ctrl + D` | Duplicate | Board |
| `Cmd/Ctrl + A` | Select all | Board |
| `Delete` / `Backspace` | Delete selection | Board |
| `Escape` | Deselect / cancel / close modal | Global |
| `Arrow keys` | Nudge 1 px | Board |
| `Shift + Arrow` | Nudge 10 px | Board |
| `Cmd/Ctrl + Scroll` | Zoom | Board |
| `Cmd/Ctrl + 0` | Reset zoom to 100% | Board |
| `Cmd/Ctrl + 1` | Zoom to fit | Board |
| `Cmd/Ctrl + +` / `-` | Zoom in / out | Board |
| `]` | Bring forward | Board |
| `Cmd/Ctrl + ]` | Bring to front | Board |
| `[` | Send backward | Board |
| `Cmd/Ctrl + [` | Send to back | Board |
| `?` | Shortcuts modal | Global |
| `Cmd/Ctrl + Enter` | Submit form | Forms |

**Rule:** every shortcut is disabled while a text input or on-canvas text editor has focus, except `Escape` and `Cmd/Ctrl+Enter`.

---

# 15. Appendix B — Design tokens

| Token | Value | Use |
|---|---|---|
| `--color-bg-canvas` | `#FAFAFA` | Canvas background |
| `--color-bg-app` | `#FFFFFF` | Panels, header |
| `--color-bg-subtle` | `#F4F4F5` | Dashboard background |
| `--color-border` | `#E4E4E7` | Dividers, panel edges |
| `--color-text-primary` | `#18181B` | Body text |
| `--color-text-secondary` | `#71717A` | Metadata, hints |
| `--color-accent` | `#4F46E5` | Primary buttons, active tool |
| `--color-danger` | `#DC2626` | Delete, errors |
| `--color-success` | `#16A34A` | Connected, confirmations |
| `--color-warning` | `#D97706` | Reconnecting |
| `--radius-sm` / `md` / `lg` | 4 / 8 / 12 px | Controls / panels / modals |
| `--shadow-panel` | `0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06)` | Floating panels |
| `--space-*` | 4, 8, 12, 16, 24, 32, 48 px | 4 px base scale — never use arbitrary spacing |
| `--font-sans` | `Inter, system-ui, -apple-system, sans-serif` | All UI |
| `--duration-fast` / `base` / `slow` | 120 / 200 / 320 ms | Micro / standard / modal transitions |
| `--easing-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Default easing |

**Presence palette (12 colours, assigned round-robin per room):**
`#EF4444`, `#F97316`, `#EAB308`, `#84CC16`, `#22C55E`, `#14B8A6`, `#06B6D4`, `#3B82F6`, `#6366F1`, `#A855F7`, `#EC4899`, `#F43F5E`

**Sticky note palette (8 colours):**
`#FEF08A` yellow, `#FED7AA` orange, `#FBCFE8` pink, `#FECACA` red, `#E9D5FF` purple, `#BFDBFE` blue, `#BBF7D0` green, `#E4E4E7` grey
