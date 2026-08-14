# User Flows & Screen Architecture
## Project: **CoBoard** — Real-Time Collaborative Whiteboard

| Field | Value |
|---|---|
| Document type | Flow Specification |
| Version | 1.0 |
| Audience | Intern engineering team, design, QA |
| Companion docs | `01-PRD.md`, `03-TRD.md` |

---

# 0. How to read this document

This document answers one question exhaustively: **"When the user does X on screen A, what happens and where do they end up?"**

Structure:
- **§1** — The screen map. Every screen and every edge between screens.
- **§2** — Routing rules and guards. What happens on a cold load of any URL.
- **§3–§13** — Every flow, step by step, with entry points, exits, states, and edge cases.
- **§14** — The board canvas layout, region by region.
- **§15** — Interaction state machines (the hard part).
- **§16** — Cross-cutting behaviours (modals, toasts, focus).

Notation used throughout:

| Symbol | Meaning |
|---|---|
| `S-NN` | Screen ID from PRD §6 |
| `→` | Navigation to another screen |
| `⤳` | Opens a modal / overlay (does not leave the screen) |
| `↩` | Returns / closes back to the underlying screen |
| `⟲` | Stays on the same screen, state changes only |
| `[guard]` | A condition evaluated before the transition |

---

# 1. Global screen map

## 1.1 Text map of all screens and edges

```
                          ┌──────────────────────────┐
                          │   S-01 LANDING  ( / )    │
                          └──────────────────────────┘
                             │        │         │
                 "Log in"    │        │ "Sign up"│ "Try a demo board"
                             ▼        ▼         ▼
                  ┌──────────────┐ ┌──────────────┐ ┌─────────────┐
                  │ S-03 LOGIN   │◄┤ S-02 SIGN UP │ │ S-10 BOARD  │
                  │  /login      │─►│  /signup    │ │ (demo mode) │
                  └──────────────┘ └──────────────┘ └─────────────┘
                    │        │            │
      "Forgot?"     │        │ Google     │ Google
                    ▼        ▼            ▼
      ┌──────────────────┐  ┌────────────────────────┐
      │ S-04 FORGOT PW   │  │ S-06 OAUTH CALLBACK    │
      │ /forgot-password │  │ /auth/callback         │
      └──────────────────┘  └────────────────────────┘
                    │                    │
             email link                  │
                    ▼                    │
      ┌──────────────────┐               │
      │ S-05 RESET PW    │               │
      │ /reset-password  │               │
      └──────────────────┘               │
                    │                    │
                    └────────┬───────────┘
                             ▼
              ╔════════════════════════════════╗
              ║   S-07 DASHBOARD  /dashboard   ║  ◄── default authed home
              ╚════════════════════════════════╝
                 │      │       │        │      │
        "New     │      │       │        │      │ avatar menu
         board"  │      │Trash  │Settings│      │
                 │      │       │        │      ▼
                 │      ▼       ▼        │   (logout → S-01)
                 │  ┌────────┐ ┌──────────────┐
                 │  │ S-08   │ │ S-16 SETTINGS│
                 │  │ TRASH  │ │ /settings    │
                 │  └────────┘ └──────────────┘
                 │      │
                 │      └── restore ──► back to S-07
                 │
                 │  ⤳ S-09 TEMPLATE PICKER (modal, P2)
                 ▼
    ╔═══════════════════════════════════════════════════════╗
    ║        S-10 BOARD CANVAS   /board/:boardId            ║
    ║  (the core screen — see §14 for full layout)          ║
    ╚═══════════════════════════════════════════════════════╝
       │        │         │         │        │         │
       │ ⤳S-12  │ ⤳S-13   │ ⤳S-14   │ ⤳S-15  │  back   │ failure states
       │ SHARE  │ SETTINGS│ EXPORT  │SHORTCUT│  ──────►│ S-17 / S-18 / S-19
       ▼        ▼         ▼         ▼        ▼         ▼
    (all modals return ↩ to S-10)          S-07     full-screen states


  GUEST ENTRY PATH (no account):
  ┌──────────────────────────┐      name entered      ┌──────────────┐
  │ S-11 GUEST NAME ENTRY    │ ─────────────────────► │ S-10 BOARD   │
  │ /join/:token             │                        │ (guest role) │
  └──────────────────────────┘                        └──────────────┘
        ▲                                                    │
        │ link clicked, no session                           │ "Sign up to
        └────────────────────────────────────────────────    │  save boards"
                                                             ▼
                                                        S-02 SIGN UP
                                                     (returns to board)

  UNIVERSAL FALLBACKS (reachable from anywhere):
  S-20 GENERIC 404  (*)         S-21 ERROR BOUNDARY (JS crash)
```

## 1.2 Edge table — every navigation in the app

| From | Trigger | Guard | To | Type |
|---|---|---|---|---|
| S-01 | "Log in" | — | S-03 | → |
| S-01 | "Sign up free" / hero CTA | — | S-02 | → |
| S-01 | "Try it now" | — | S-10 (demo) | → |
| S-01 | Logo | — | S-01 | ⟲ |
| S-01 | Load with valid session | authed | S-07 | → (redirect) |
| S-02 | Successful signup | — | S-07 or `?next=` | → |
| S-02 | "Already have an account?" | — | S-03 | → |
| S-02 | "Continue with Google" | — | S-06 | → (external round-trip) |
| S-03 | Successful login | — | S-07 or `?next=` | → |
| S-03 | "Create one" | — | S-02 | → |
| S-03 | "Forgot password?" | — | S-04 | → |
| S-04 | Submit email | — | S-04 confirmation state | ⟲ |
| S-04 | "Back to log in" | — | S-03 | → |
| S-05 | Successful reset | — | S-03 with success banner | → |
| S-05 | Invalid/expired token | — | S-04 with error banner | → |
| S-06 | OAuth success | — | S-07 or `?next=` | → |
| S-06 | OAuth failure/denied | — | S-03 with error banner | → |
| S-07 | "New board" | — | S-10 (new board) | → |
| S-07 | Click board card | member | S-10 | → |
| S-07 | Card menu → Rename | owner | inline edit | ⟲ |
| S-07 | Card menu → Duplicate | member | S-07 with new card | ⟲ |
| S-07 | Card menu → Share | owner | ⤳ S-12 | ⤳ |
| S-07 | Card menu → Delete | owner | ⤳ confirm → S-07 | ⤳ |
| S-07 | Sidebar "Trash" | — | S-08 | → |
| S-07 | Avatar → "Settings" | — | S-16 | → |
| S-07 | Avatar → "Log out" | — | S-01 | → |
| S-08 | "Restore" | owner | S-08 (row removed) | ⟲ |
| S-08 | "Delete forever" | owner | ⤳ typed confirm → S-08 | ⤳ |
| S-08 | "Back to boards" | — | S-07 | → |
| S-10 | Back arrow / logo | authed | S-07 | → |
| S-10 | Back arrow | guest | S-01 | → |
| S-10 | "Share" | owner | ⤳ S-12 | ⤳ |
| S-10 | Title menu → Settings | owner | ⤳ S-13 | ⤳ |
| S-10 | "Export" | any | ⤳ S-14 | ⤳ |
| S-10 | `?` key | any | ⤳ S-15 | ⤳ |
| S-10 | 403 from server | — | S-17 | ⟲ (full-screen state) |
| S-10 | 404 from server | — | S-18 | ⟲ |
| S-10 | `board:deleted` socket event | — | S-19 | ⟲ |
| S-11 | Name submitted | valid token | S-10 (guest) | → |
| S-11 | Invalid/revoked token | — | S-17 | → |
| S-11 | "Log in instead" | — | S-03 with `?next=` | → |
| S-12 | Close / Escape / backdrop | — | ↩ underlying | ↩ |
| S-17 | "Back to dashboard" | authed | S-07 | → |
| S-17 | "Back to home" | guest | S-01 | → |
| S-18 | "Back to dashboard" | — | S-07 | → |
| S-19 | "Back to dashboard" | — | S-07 | → |
| S-20 | "Take me home" | — | S-01 or S-07 | → |
| S-21 | "Reload" | — | full page reload | — |

---

# 2. Routing, guards, and cold-load behaviour

## 2.1 Route table

| Route | Component | Guard | Redirect if guard fails |
|---|---|---|---|
| `/` | Landing | `redirectIfAuthed` | `/dashboard` |
| `/login` | Login | `redirectIfAuthed` | `/dashboard` |
| `/signup` | Signup | `redirectIfAuthed` | `/dashboard` |
| `/forgot-password` | ForgotPassword | `redirectIfAuthed` | `/dashboard` |
| `/reset-password` | ResetPassword | requires `?token=` | `/forgot-password` |
| `/auth/callback` | OAuthCallback | requires `?code=` | `/login?error=oauth` |
| `/dashboard` | Dashboard | `requireAuth` | `/login?next=/dashboard` |
| `/dashboard/trash` | Trash | `requireAuth` | `/login?next=…` |
| `/settings` | Settings | `requireAuth` | `/login?next=/settings` |
| `/board/:boardId` | Board | `requireBoardAccess` | see §2.3 |
| `/join/:token` | GuestEntry | none | — |
| `*` | NotFound | none | — |

## 2.2 The `requireAuth` guard — exact sequence

```
1. Is there an access token in memory?
   YES → proceed to route.
   NO  → step 2.

2. Attempt silent refresh: POST /api/auth/refresh (sends httpOnly cookie).
   Render a full-screen branded spinner while this is in flight.
   Do NOT flash the login screen. A flash of login is a bug, not a cosmetic issue.

3. Refresh succeeds → store the new access token in memory → proceed to route.
   Refresh fails (401) → redirect to /login?next=<current-path-and-query>.

4. On successful login, read `next`, validate it is a same-origin relative path
   (reject anything starting with `//` or containing a scheme), and navigate there.
   If invalid or absent → /dashboard.
```

## 2.3 The `requireBoardAccess` guard — the most important guard in the app

Cold-loading `/board/:boardId` is the single most complex entry point. Exact order:

```
STEP 1 — Render the board shell immediately.
  Header skeleton, toolbar (disabled), canvas area with a centred spinner.
  Never render a blank white page while resolving access.

STEP 2 — Resolve identity, in this priority order:
  a. Access token in memory → authenticated user.
  b. No token → attempt silent refresh (§2.2 step 2).
  c. Refresh fails → check localStorage `coboard.guest` for a guest identity
     scoped to this board.
  d. No guest identity either → anonymous.

STEP 3 — Request access: GET /api/boards/:boardId/access
  Payload includes the guest id (if any) and the share token from
  sessionStorage (if the user arrived via /join/:token).

STEP 4 — Branch on the response:

  200 { role: "owner" | "editor" | "viewer" }
      → Proceed to STEP 5.

  200 { role: "none", joinable: true, requiresName: true }
      → The board has an open share link but we don't know who this is.
      → Redirect to /join/:token (S-11).

  403 { reason: "no_access" }
      → Render S-17 Access Denied in place of the canvas.
      → Do NOT open a WebSocket.

  403 { reason: "link_revoked" }
      → Render S-17 with the "access removed" copy.

  404
      → Render S-18 Board Not Found.

  410 { reason: "deleted" }
      → Render S-18 with the "deleted" copy.

  5xx / network failure
      → Render an inline retry state inside the canvas area with a
        "Try again" button. Do not navigate away; the user's URL is valid.

STEP 5 — Load content and connect, IN PARALLEL:
  a. GET /api/boards/:boardId/snapshot  → returns { objects[], seq, meta }
  b. Open the WebSocket and send `join` with { boardId, sinceSeq: 0 }

  Buffer any incoming ops from (b) until (a) resolves, then:
    - Apply the snapshot.
    - Replay buffered ops whose seq > snapshot.seq.
    - Drop buffered ops whose seq <= snapshot.seq (already included).
  This ordering rule is what prevents the classic "object flickers in
  then disappears" bug. Do not deviate from it.

STEP 6 — Remove the spinner, enable the toolbar per role, render presence,
  fire the `board_opened` analytics event with the measured load time.
```

## 2.4 Cold-load decision tree for `/board/:boardId`

```
                    URL entered
                         │
                ┌────────┴────────┐
                │ Board exists?   │
                └────────┬────────┘
              NO ────────┤──────── YES
              │          │
          S-18 404       │
                ┌────────┴────────┐
                │ Board deleted?  │
                └────────┬────────┘
              YES ───────┤──────── NO
              │          │
        S-18 (deleted)   │
                ┌────────┴────────────┐
                │ Viewer is a member? │
                └────────┬────────────┘
              YES ───────┤──────── NO
              │          │
         Enter board     │
         with their      ├──────────────────┐
         role            │                  │
                ┌────────┴────────┐         │
                │ Open share link │         │
                │ token present?  │         │
                └────────┬────────┘         │
              YES ───────┤──────── NO ──────┘
              │                              │
      ┌───────┴────────┐                     ▼
      │ Logged in?     │                  S-17 403
      └───────┬────────┘
    YES ──────┤────── NO
    │         │
 Auto-join    ▼
 as the    S-11 Guest name entry
 link's       │
 role         ▼
           Enter board as guest
```

---

# 3. Flow — First-time visitor signs up

**Persona:** Priya. **Entry:** organic visit to `/`.

## 3.1 Steps

| # | Screen | User action | System response | Next |
|---|---|---|---|---|
| 1 | S-01 | Lands on `/` | Hero renders with a live looping demo of two cursors drawing. Header shows "Log in" and "Sign up free" | — |
| 2 | S-01 | Clicks "Sign up free" | Client-side navigate | → S-02 |
| 3 | S-02 | Sees the form | Focus is auto-placed in the Email field | — |
| 4 | S-02 | Types email | On blur, validate format. Invalid → inline error below the field, red border, `aria-invalid` | ⟲ |
| 5 | S-02 | Types password | Live strength meter (weak/fair/strong) and a checklist: "8+ characters ✓ / a letter ✓ / a number ✗". Show/hide toggle available | ⟲ |
| 6 | S-02 | Types display name | Trim on blur. Empty after trim → error | ⟲ |
| 7 | S-02 | Clicks "Create account" | Button enters loading state with a spinner and is disabled. All inputs become read-only | ⟲ |
| 8a | S-02 | — | **201** — store tokens, prefetch dashboard data | → S-07 |
| 8b | S-02 | — | **409 email exists** — inline error on the email field + a "Log in instead" link that carries the typed email to S-03 | ⟲ |
| 8c | S-02 | — | **422 validation** — map each server field error to its input | ⟲ |
| 8d | S-02 | — | **429** — form-level error with a countdown; button stays disabled until it expires | ⟲ |
| 8e | S-02 | — | **Network failure** — form-level error "Couldn't reach the server. Check your connection." + Retry. **Typed values are preserved.** | ⟲ |
| 9 | S-07 | Arrives | Empty state: "Nothing here yet" + "New board" CTA. A one-time success toast: "Welcome to CoBoard" | — |

## 3.2 Validation rules (S-02)

| Field | Rule | Timing | Error copy |
|---|---|---|---|
| Email | Non-empty | On submit | "Enter your email." |
| Email | Valid format | On blur + on submit | "That doesn't look like an email address." |
| Password | ≥ 8 chars | Live checklist, blocks submit | "Password needs at least 8 characters, including a letter and a number." |
| Password | ≥1 letter, ≥1 number | Live checklist | (same) |
| Display name | 1–40 after trim | On blur | "Enter a name so others know who you are." |

**Rules that apply to every form in this app:**
- Never validate a field before the user has left it for the first time. Validating on the first keystroke is hostile.
- Once a field has shown an error, re-validate on every keystroke so the error clears the moment it is fixed.
- Submit is never disabled for validation reasons — let the user click and show them what's wrong. It **is** disabled while a request is in flight.
- `Enter` in any field submits the form.
- Form-level errors appear above the submit button and receive focus for screen readers.

## 3.3 Google OAuth branch

```
S-02/S-03 "Continue with Google"
   → store `next` in sessionStorage
   → window.location = /api/auth/google
   → Google consent screen (external)
   → callback to /auth/callback?code=…
   → S-06 renders a centred spinner: "Signing you in…"
   → POST the code to the server, receive tokens
   → SUCCESS: read `next` from sessionStorage → S-07 or the target
   → USER DENIED: → S-03 with banner "Google sign-in was cancelled."
   → SERVER ERROR: → S-03 with banner "Couldn't sign in with Google. Try email instead."
```
S-06 must never be a screen the user sees for more than ~1 second. If it exceeds 5 seconds, show "Still working…" and after 15 seconds fail over to S-03 with an error.

---

# 4. Flow — Returning user logs in

| # | Screen | Action | Response | Next |
|---|---|---|---|---|
| 1 | any | Opens `coboard.app` | `redirectIfAuthed` runs silent refresh | → S-07 if valid |
| 2 | S-03 | Enters credentials, submits | Loading state | ⟲ |
| 3a | S-03 | — | 200 → tokens stored | → S-07 or `next` |
| 3b | S-03 | — | 401 → "That email or password didn't match. Try again." Password field is cleared, email is kept, focus returns to password | ⟲ |
| 3c | S-03 | — | 429 → "Too many attempts. Try again in 12 minutes." Submit disabled with a live countdown | ⟲ |
| 3d | S-03 | — | 403 account disabled → "This account has been disabled. Contact support." | ⟲ |

**Deep-link preservation:** if the user was sent to `/login?next=/board/abc123`, after login they land directly on that board, not on the dashboard. Test this explicitly — it is the single most common regression in auth work.

---

# 5. Flow — Password reset

```
S-03 "Forgot password?"
  → S-04  [state: form]
      User enters email, submits
      → Server always returns 200 regardless of whether the email exists
      → S-04 [state: confirmation]
          "Check your email"
          "If an account exists for priya@x.com, we've sent a reset link.
           It expires in 60 minutes."
          Secondary: "Resend" (disabled for 60 s with a countdown)
          Link: "Back to log in" → S-03

  Email arrives → user clicks the link
  → S-05 /reset-password?token=…
      On mount, validate the token: GET /api/auth/reset/validate?token=…
        VALID   → render the new-password form (password + confirm)
        EXPIRED → S-04 with banner "That reset link expired. Request a new one."
        INVALID → S-04 with banner "That reset link isn't valid. Request a new one."
        USED    → S-04 with banner "That link was already used. Request a new one."

      Submit new password
        SUCCESS → invalidate all sessions for the user
                → S-03 with a green banner "Password updated. Log in with your new password."
        FAIL    → inline error, stay on S-05
```

**Do not** auto-log-in after a reset. Requiring an explicit login confirms the user actually knows the new password.

---

# 6. Flow — Dashboard

## 6.1 Layout regions

```
┌─────────────────────────────────────────────────────────────────┐
│ HEADER: [CoBoard logo]   [search boards…]        [+ New board] [avatar▾] │
├────────────┬────────────────────────────────────────────────────┤
│ SIDEBAR    │  CONTENT                                           │
│            │  ┌──────────────────────────────────────────────┐  │
│ ▸ All      │  │ Tabs: All | Owned | Shared | Starred         │  │
│ ▸ Owned    │  │ Sort: [Last edited ▾]      View: [grid|list] │  │
│ ▸ Shared   │  ├──────────────────────────────────────────────┤  │
│ ▸ Starred  │  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │  │
│ ▸ Trash    │  │  │ card   │ │ card   │ │ card   │ │ card   │ │  │
│            │  │  └────────┘ └────────┘ └────────┘ └────────┘ │  │
│ ─────────  │  │  ┌────────┐ ┌────────┐                       │  │
│ ▸ Settings │  │  │ card   │ │ card   │                       │  │
│            │  │  └────────┘ └────────┘                       │  │
└────────────┴──└──────────────────────────────────────────────┘──┘
```

## 6.2 Board card anatomy

```
┌───────────────────────────────┐
│                               │  ← thumbnail (16:10), lazy-loaded,
│      [board thumbnail]        │    skeleton shimmer while loading,
│                               │    placeholder graphic if the board is empty
│                          [⋮]  │  ← menu button, appears on hover/focus
├───────────────────────────────┤
│ Q3 Retrospective          [★] │  ← name (truncate 1 line), star toggle
│ Edited 2 hours ago            │  ← relative time, `title` = absolute time
│ (A)(B)(C) +2                  │  ← member avatars, max 4 + overflow
└───────────────────────────────┘
```

## 6.3 Dashboard states

| State | Condition | Rendering |
|---|---|---|
| Loading | Initial fetch in flight | 8 skeleton cards, correct dimensions, shimmer. **No spinner** — skeletons prevent layout shift |
| Loaded, has boards | ≥1 board | Grid of cards |
| Empty (no boards ever) | 0 boards, "All" tab | Illustration + "Nothing here yet" + "New board" CTA |
| Empty (filter) | 0 results on a filter tab | "No boards match that filter" + "Clear filter" |
| Empty (search) | 0 results for a query | "No boards found for '{query}'" + "Clear search" |
| Error | Fetch failed | Inline error card + "Retry". Sidebar and header remain functional |
| Partial error | Boards loaded, thumbnails failed | Cards render with placeholder thumbnails. Do not fail the whole page for a thumbnail |

## 6.4 Card menu (⋮) contents by role

| Item | Owner | Editor/Viewer |
|---|:--:|:--:|
| Open | ✅ | ✅ |
| Open in new tab | ✅ | ✅ |
| Rename | ✅ | ❌ |
| Duplicate | ✅ | ✅ |
| Share | ✅ | ❌ |
| Copy link | ✅ | ✅ (if a link exists) |
| Star / Unstar | ✅ | ✅ |
| Export as PNG | ✅ | ✅ |
| Move to trash | ✅ | ❌ |
| Leave board | ❌ | ✅ |

## 6.5 Sub-flow — Create a board

```
Click "+ New board"
  → Button shows a spinner (do not navigate optimistically to a board
    that might fail to create)
  → POST /api/boards { name: "Untitled board" }
  → 201 { boardId }
  → navigate to /board/:boardId
  → S-10 mounts with an empty board, the socket connects, the title in the
    header is auto-focused and text-selected so the user can immediately
    type a real name without clicking anything.
  → FAILURE: toast "Couldn't create the board. Try again." Button returns
    to its idle state. Stay on S-07.
```

With templates enabled `[P2]`, "New board" opens S-09 instead: a modal with 5 template tiles; clicking one creates the board with those objects preloaded.

## 6.6 Sub-flow — Rename from the dashboard

```
Card menu → Rename
  → The card title becomes an inline text input, pre-filled and fully selected
  → Enter or blur commits;  Escape cancels and restores the old name
  → Optimistically update the card title immediately
  → PATCH /api/boards/:id { name }
  → Failure: revert the title and show a toast "Couldn't rename that board."
  → If anyone is currently in that board, they receive a `board:renamed`
    socket event and their header title updates live
```

## 6.7 Sub-flow — Delete (move to trash)

```
Card menu → "Move to trash"
  → Confirmation modal:
       Title:  "Move '{name}' to trash?"
       Body:   "Anyone working on this board will be disconnected.
                You can restore it for 30 days."
       Buttons: [Cancel]  [Move to trash] (danger colour)
  → Confirm:
       DELETE /api/boards/:id
       → Card animates out of the grid (fade + collapse, 200 ms)
       → Toast: "Moved to trash"  with an "Undo" action for 8 seconds
       → Undo clicked → POST /api/boards/:id/restore → card animates back in
       → Server broadcasts `board:deleted` to the room
       → Every connected client transitions to S-19
```

## 6.8 Sub-flow — Trash (S-08)

```
S-07 sidebar "Trash" → S-08
  Row layout: [thumbnail] [name] [deleted 3 days ago] [28 days left] [Restore] [Delete forever]

  "Restore"
     → POST /api/boards/:id/restore
     → row animates out, toast "Restored to your boards"
     → S-08 (or auto-navigate to S-07 if the trash is now empty)

  "Delete forever"
     → Modal requiring the user to TYPE the exact board name
     → The confirm button stays disabled until the typed text matches exactly
     → Confirm → DELETE /api/boards/:id/permanent
     → Irreversible. The modal copy must say so plainly.
```

---

# 7. Flow — Guest joins via a shared link

**Persona:** Marcus. This is the flow that must be fastest and is therefore the one to obsess over.

## 7.1 Happy path

| # | Where | Action | System | Next |
|---|---|---|---|---|
| 1 | Slack | Clicks `coboard.app/join/9fK2…` | Browser opens the link | — |
| 2 | S-11 | Page loads | Store the token in `sessionStorage`. Validate it: `GET /api/share/:token` | — |
| 3 | S-11 | — | 200 → render the join card | — |
| 4 | S-11 | Sees the card | Board name, owner name, "3 people are here now" with live avatars, a name input (auto-focused), and a "Join board" button | — |
| 5 | S-11 | Types "Marcus", presses Enter | Persist `{id: uuid, name, colour}` to `localStorage.coboard.guest` | — |
| 6 | S-11 | — | `POST /api/share/:token/join { guestId, name }` → returns `{ boardId, role }` | — |
| 7 | — | — | `navigate('/board/' + boardId, { replace: true })` — **replace**, so Back does not return to the join screen | → S-10 |
| 8 | S-10 | Board loads | Snapshot + socket connect run in parallel (§2.3 step 5) | — |
| 9 | S-10 | Board ready | Toast: "You're in as Marcus". Existing users see "Marcus joined" | — |

**Total target: under 10 seconds from click to first stroke.**

## 7.2 Returning guest

If `localStorage.coboard.guest` exists **and** the token is still valid, **skip S-11 entirely** and go straight to the board. Show a small dismissible chip in the corner: "Joined as Marcus — [Not you?]". Clicking "Not you?" clears the stored identity and returns to S-11.

## 7.3 S-11 failure branches

| Response | Screen | Copy |
|---|---|---|
| 404 token | S-17 | "This link isn't valid. Ask whoever shared it for a new one." |
| 410 revoked | S-17 | "This link has been turned off." |
| 410 board deleted | S-18 | "This board no longer exists." |
| 403 board full | S-11 error state | "This board is full right now. Try again in a few minutes." + Retry |
| Name empty on submit | S-11 | Inline: "Enter a name so others know who you are." |
| Name > 40 chars | S-11 | Hard-stop input at 40 with a character counter shown from 30 onward |

## 7.4 Guest → account conversion

A persistent but non-intrusive bar sits at the bottom of the board for guests:

> "You're a guest. Sign up to save your boards." **[Sign up]** [×]

```
Click "Sign up"
  → open S-02 in a NEW TAB (do not destroy their board session)
  → on signup completion, the new tab posts a message to the opener
  → the board tab silently upgrades: guest identity is replaced by the
    real account, the guest is added as an Editor, the presence entry
    updates its name, and the bar disappears
  → NOTHING on the canvas is lost
```
Dismissing with `×` hides the bar for that board for 7 days (`localStorage`).

---

# 8. Flow — Opening and working in a board (S-10)

## 8.1 Load sequence with timing targets

| t (ms) | What the user sees |
|---|---|
| 0 | Click / navigation begins |
| ~50 | Board shell: header skeleton, disabled toolbar, canvas with a centred spinner |
| ~150 | Board name and member avatars populate from the access response |
| ~400 | Snapshot arrives; objects paint. Spinner removed |
| ~450 | Socket confirms join; connection dot turns green; presence avatars appear |
| ~500 | Toolbar enabled per role; keyboard shortcuts armed; board is fully interactive |

If the snapshot takes more than 2 seconds, show a progress message under the spinner: "Loading 4,312 objects…". Silence past 2 seconds reads as a broken page.

## 8.2 In-board sub-flows

### 8.2.1 Draw a freehand stroke

```
1. User presses `P` or clicks the pen tool.
   → Tool button becomes active (accent background)
   → Properties panel swaps to pen options (colour, thickness, opacity)
   → Cursor changes to a crosshair
   → Persist the tool choice to localStorage so it survives a refresh

2. pointerdown on the canvas
   → setPointerCapture on the canvas element (critical: without this,
     dragging outside the window loses the stroke)
   → Generate a client-side op id (uuid v4)
   → Create a draft stroke in local state with the first point
   → Begin rendering on the INTERACTION layer, not the main object layer

3. pointermove (fires up to 240 Hz on high-refresh devices)
   → Append the point (converted screen → canvas coordinates)
   → Redraw only the interaction layer
   → Throttled to 20 Hz: broadcast a `presence:stroke_progress` message
     with the points added since the last send

4. pointerup / pointercancel
   → releasePointerCapture
   → Simplify the point list (Ramer–Douglas–Peucker, ε = 0.5 canvas px)
   → Commit locally: move the object from the interaction layer to the
     main object layer, add it to the object map
   → Push an inverse op (delete) onto the local undo stack
   → Emit `op:create` over the socket; add it to the outbox
   → Clear the presence stroke

5. Server acknowledges with a sequence number
   → Remove the op from the outbox
   → Store the assigned seq on the local object

6. Server rejects (permission, validation, rate limit)
   → Remove the object locally
   → Remove its undo entry
   → Toast: "That change couldn't be saved."
```

### 8.2.2 Place and edit a sticky note

```
1. Press `N` or click the sticky tool. Properties panel shows the 8 colours.
2. Click on the canvas.
   → A 200×200 note is created at the click point, centred on the cursor
   → The op is emitted immediately (the empty note is a real object)
   → The note IMMEDIATELY enters edit mode: a transparent textarea is
     overlaid, positioned and scaled to match the note's screen rect,
     and focused
3. User types.
   → The overlay textarea holds the text; the canvas note renders the
     text live beneath it
   → Debounced 300 ms: emit `op:update` with the new text
   → Remote users see the text appear as it is typed (debounced)
4. Escape, or click outside, or Tab
   → Commit the final text, remove the overlay, select the note
   → If the note is still empty AND was created in this interaction,
     delete it silently — no empty notes on the board
```

**Why an overlaid textarea instead of implementing a text cursor on canvas:** IME input, spellcheck, mobile keyboards, accessibility, text selection, and copy/paste all come free. Implementing a caret on canvas is weeks of work and will be worse. Do not do it.

### 8.2.3 Select and transform

```
SINGLE SELECT
  pointerdown on an object (hit-test top-down through z-order)
    → selection = [objectId]
    → render the bounding box + 8 resize handles + 1 rotate handle on
      the OVERLAY layer
    → properties panel shows that object's properties
    → broadcast `presence:selection` so others see the highlight

MULTI SELECT
  Shift + click        → toggle membership in the selection
  drag on empty canvas → marquee rectangle on the overlay layer;
                         on release, select all objects FULLY contained
    → bounding box becomes the union of all selected objects
    → the properties panel shows only properties common to all selected
      types; mixed values render as "Mixed"

MOVE
  pointerdown inside the bounding box → dragging = true
    → store the start pointer position and each object's start position
    → on pointermove: newPos = startPos + (currentPointer - startPointer),
      in CANVAS coordinates
    → check alignment guides against non-selected objects within the viewport
    → throttled 20 Hz: broadcast `presence:transform` (ephemeral)
    → on pointerup: emit one `op:update` per moved object (batched in a
      single message), push ONE undo entry for the whole group

RESIZE
  pointerdown on a handle → resizing = true, record which handle
    → compute the new bounding box from the anchor (opposite handle)
    → Shift → preserve the original aspect ratio
    → Alt   → resize about the centre
    → apply the scale factor to every selected object's geometry
    → enforce a minimum of 8×8; below that, clamp — never allow negative
      dimensions or a flipped box unless flipping is explicitly supported
    → commit on pointerup, exactly like MOVE

ROTATE
  pointerdown on the rotate handle
    → angle = atan2(pointer - boundingBoxCentre)
    → Shift snaps to 15°
    → display a live degree readout near the cursor
    → commit on pointerup
```

### 8.2.4 Pan and zoom

```
PAN triggers (all must work):
  - Hold Space + drag           (cursor → grabbing)
  - Middle-mouse drag
  - Two-finger trackpad scroll  (wheel event, ctrlKey === false)
  - Hand tool (`H`) + drag
  - Right-drag  [P2]

  Implementation: mutate viewport.x / viewport.y only. Do NOT touch object
  data. Do NOT re-run hit-testing during a pan.

ZOOM triggers:
  - Cmd/Ctrl + wheel
  - Pinch on trackpad (wheel event with ctrlKey === true — this is how
    browsers report trackpad pinch; you will not find a "pinch" event)
  - Zoom buttons, Cmd +/-
  - Cmd+0 → 100%,  Cmd+1 → zoom to fit

  Anchored zoom maths (memorise this, you will write it three times):
    const worldPos = screenToCanvas(pointerScreenPos, viewport)
    const newZoom  = clamp(viewport.zoom * factor, 0.1, 5)
    viewport.x = pointerScreenPos.x - worldPos.x * newZoom
    viewport.y = pointerScreenPos.y - worldPos.y * newZoom
    viewport.zoom = newZoom

  ZOOM TO FIT:
    - compute the bounding box of all objects
    - if there are no objects → reset to (0, 0, zoom 1)
    - add 10% padding, fit to the canvas viewport rect, clamp to [0.1, 5]
```

### 8.2.5 Undo / redo (user-facing behaviour)

```
Cmd+Z
  → pop the top entry from the local undo stack
  → if the entry targets an object that no longer exists (someone deleted it):
       DISCARD the entry silently and pop the next one
       (a maximum of 10 discards per keypress, to avoid a runaway loop)
  → apply the inverse operation locally
  → emit it as a normal op (remote users see it as an ordinary change,
    not as "an undo")
  → push the forward operation onto the redo stack

Cmd+Shift+Z
  → pop from the redo stack, apply, push onto the undo stack

Any NEW user action clears the redo stack. Always. No exceptions.

Remote ops NEVER touch the local undo stack. This is the whole rule.
If you find yourself pushing a remote op onto the undo stack, you have
introduced the bug where undoing reverts a teammate's work.
```

---

# 9. Flow — Real-time collaboration behaviours

## 9.1 A second user joins a live board

```
Client B                     Server                      Client A (already in)
   │                            │                                │
   ├── WS connect + auth ──────►│                                │
   │                            ├── validate token/role          │
   │◄── join_ack {seq, users} ──┤                                │
   │                            ├── add B to the room            │
   │                            ├── presence:join ──────────────►│
   │                            │                        Toast: "Marcus joined"
   │                            │                        Avatar appears in header
   ├── GET snapshot ───────────►│                                │
   │◄── objects[] + seq ────────┤                                │
   │  (buffered ops replayed)   │                                │
   │  canvas paints             │                                │
   ├── presence:cursor ────────►├───────────────────────────────►│
   │                            │                     B's cursor appears
```

## 9.2 Cursor rendering rules

| Rule | Value |
|---|---|
| Send rate | Throttled to 20 Hz (every 50 ms), and only if the position actually changed |
| Send format | Canvas coordinates, rounded to 1 decimal place |
| Receive handling | Interpolate between the last and new position over 50 ms with linear easing. Raw jumps look broken |
| Layer | Overlay canvas / DOM layer, never the object canvas |
| Idle 5 s | Fade to 40% opacity |
| Idle 15 s | Hide entirely (the avatar remains in the header) |
| Off-screen | Show a small coloured chevron pinned to the viewport edge, pointing toward the user `[P2]` |
| Own cursor | Never render your own remote cursor. Obvious, and everyone builds this bug once |

## 9.3 Concurrent edit matrix

| A does | B does (same moment) | Result | User-visible? |
|---|---|---|---|
| Moves object X | Moves object Y | Both move | No conflict |
| Moves object X | Recolours object X | Both apply (different fields) | No |
| Sets X fill red | Sets X fill blue | Later server seq wins | The loser sees the colour change under them. Accepted |
| Deletes X | Moves X | X stays deleted, the move is dropped | The mover's object vanishes mid-drag. Snap the drag to an end and show no error |
| Deletes X | Deletes X | Idempotent — the second delete is a no-op | No |
| Creates a stroke | Creates a stroke | Both exist, ordered by seq | No |
| Reorders z-index | Reorders z-index | Fractional indexing keeps both valid | No |

## 9.4 Disconnect and reconnect flow

```
STATE: CONNECTED
   │  socket 'close' or 'error', or navigator.onLine === false
   ▼
STATE: RECONNECTING (attempt 1)
   - Header indicator → amber "Reconnecting… (attempt 1)"
   - Toolbar STAYS ENABLED. The user keeps working
   - Every op goes to the outbox instead of the wire
   - Remote cursors freeze, then fade out after 5 s, then hide at 15 s
   - Presence avatars get a subtle "stale" desaturation
   │
   ├── retry with exponential backoff + jitter:
   │     1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s… capped at 30 s
   │     (full jitter: actual delay = random(0, computed))
   │
   ├─ SUCCESS ──────────────────────────────────┐
   │                                            ▼
   │                                    STATE: SYNCING
   │        - Header → blue "Syncing 12 changes…"
   │        - send `join` with { sinceSeq: lastAppliedSeq }
   │        - server returns every op with seq > sinceSeq
   │        - apply them in seq order
   │        - flush the outbox in FIFO order, each with its original
   │          client-generated op id so the server can deduplicate
   │        - await acks; remove each op from the outbox on ack
   │        - if an op is REJECTED (e.g. it targets an object that was
   │          deleted while we were away): drop it silently, remove its
   │          undo entry
   │        - outbox empty → STATE: CONNECTED, header → green
   │        - Toast: "Back online — 12 changes synced"
   │
   └─ after 8 failed attempts OR navigator.onLine === false
         ▼
      STATE: OFFLINE
        - Header → red "Offline — changes saved locally"
        - Persist the outbox to localStorage (survives an accidental refresh)
        - Show a "Retry now" button that resets the backoff to attempt 1
        - Listen for the `online` event and retry immediately when it fires
        - If the outbox exceeds 500 ops or 10 minutes elapse:
             banner "You've been offline a while. Refresh when you're back
             online to make sure everything is up to date."
```

## 9.5 Ejection flows (the board goes away underneath the user)

| Event | Trigger | Client behaviour |
|---|---|---|
| `board:deleted` | Owner trashes the board | Immediately freeze the canvas, close the socket, render **S-19** as a full-screen overlay: "The owner deleted this board." + [Back to dashboard]. Do not attempt to sync the outbox — the target is gone |
| `access:revoked` | Owner removes a member or revokes a link | Same treatment, **S-17** copy: "Your access to this board was removed." |
| `role:changed` to viewer | Owner demotes an editor | Do **not** eject. Disable the toolbar, cancel any in-progress interaction, show a toast: "You're now a viewer on this board." |
| `board:renamed` | Anyone renames it | Header title updates live. No toast |
| Server shutdown | Deploy / restart | Normal reconnect flow. The user should ideally see a brief amber flicker and nothing more |

---

# 10. Flow — Sharing (S-12)

## 10.1 Share modal anatomy

```
┌──────────────────────────────────────────────────────┐
│  Share "Q3 Retrospective"                        [×] │
├──────────────────────────────────────────────────────┤
│  Invite by email                                     │
│  ┌──────────────────────────────┐ ┌────────┐ ┌─────┐ │
│  │ name@company.com             │ │Editor ▾│ │Send │ │
│  └──────────────────────────────┘ └────────┘ └─────┘ │
├──────────────────────────────────────────────────────┤
│  People with access                                  │
│  (P) Priya Sharma   priya@x.com        Owner         │
│  (M) Marcus Lee     marcus@x.com      [Editor ▾]     │
│  (D) Dana (guest)   —                 [Viewer ▾]     │
├──────────────────────────────────────────────────────┤
│  General access                                      │
│  🔗 [ Anyone with the link ▾ ]  [ can edit ▾ ]       │
│  https://coboard.app/join/9fK2mQ…       [ Copy ]     │
│  [ Reset link ]                                      │
└──────────────────────────────────────────────────────┘
```

## 10.2 Interactions

| Control | Behaviour |
|---|---|
| Email input | Accepts comma/Enter-separated addresses, rendered as chips. Invalid addresses render as red chips and block Send |
| Role dropdown (invite) | Editor / Viewer. Not Owner |
| Send | Loading state → success toast "Invites sent to 2 people" → the list refreshes and the input clears |
| Per-member role dropdown | Changes immediately (optimistic). Failure reverts + toast. The affected user, if connected, receives `role:changed` |
| Per-member "Remove" | Confirmation only for the last editor. Sends `access:revoked` to that user |
| Access dropdown | "Restricted" (invite only) / "Anyone with the link". Switching to Restricted immediately invalidates the link and ejects link-based guests |
| Permission dropdown | "can edit" / "can view". Changing it downgrades connected link-guests live via `role:changed` |
| Copy | Copies to clipboard, the button label swaps to "Copied!" with a check icon for 2 s. If the Clipboard API fails, select the text in a read-only input and show "Press Cmd+C to copy" |
| Reset link | Confirmation modal: "Anyone using the old link will lose access." → generates a new token, ejects old-link users |
| Close | `×`, `Escape`, or a backdrop click. Focus returns to the Share button |

## 10.3 Guests in the member list

Guests appear with a "(guest)" suffix and no email. Their role can be changed or revoked individually. When a guest leaves, they remain listed for the session but are dropped once the board has been idle for 24 hours (Open Question Q-1 in the PRD).

---

# 11. Flow — Export (S-14)

```
Toolbar "Export" or Cmd+Shift+E → S-14 modal

┌────────────────────────────────────────┐
│  Export board                     [×]  │
├────────────────────────────────────────┤
│  ┌──────────────────────────────────┐  │
│  │      [ live preview thumbnail ]  │  │
│  └──────────────────────────────────┘  │
│  Scope:      (•) Whole board           │
│              ( ) Current selection     │  ← disabled when nothing is selected
│              ( ) Visible area          │
│  Format:     (•) PNG    ( ) SVG [P2]   │
│  Scale:      [ 1× ] [ 2× ]             │
│  Background: [x] Transparent           │
│  Padding:    [ 24 ] px                 │
│                                        │
│              [ Cancel ]  [ Export ]    │
└────────────────────────────────────────┘

Export clicked:
  → render to an offscreen canvas at the requested scale
  → if the estimated pixel count exceeds 8192×8192, clamp the scale and
    warn: "Scaled down to fit the maximum export size."
  → toBlob → object URL → programmatic <a download> click
  → filename: `{board-name-slugified}-{YYYY-MM-DD}.png`
  → revoke the object URL after 60 s
  → close the modal, toast "Exported"
  → for boards over 2,000 objects, show a progress indicator; render in
    chunks with `requestAnimationFrame` yields so the UI does not freeze
```

---

# 12. Error and edge-case screens

## 12.1 S-17 Access denied

```
        [ lock illustration ]
        You don't have access to this board.
        Ask the person who shared it to invite you.

        [ Request access ]  (P2)   [ Back to dashboard ]
        Signed in as priya@x.com — [Switch account]
```
Never show the board name. Leaking the name of a board someone cannot access is an information leak.

## 12.2 S-18 Board not found

```
        [ empty-page illustration ]
        This board doesn't exist, or it was deleted.
        Double-check the link, or head back to your boards.

        [ Back to dashboard ]
```

## 12.3 S-19 Board deleted while you were in it

Rendered as a full-screen overlay **on top of** the frozen canvas, so the user has visual continuity and understands what just happened.

```
        [ trash illustration ]
        The owner deleted this board.
        Your changes were saved before it was deleted.

        [ Back to dashboard ]
```

## 12.4 S-21 Error boundary

Wraps the whole app, and separately wraps the canvas subtree so a canvas crash does not take the header and navigation down with it.

```
        Something went wrong.
        We've logged the problem. Reloading usually fixes it.

        [ Reload page ]  [ Back to dashboard ]
        Ref: 8f3a2b91
```
Log the full error, component stack, board id, user id, and correlation ID to the error service. Show the user only the correlation ID.

## 12.5 Full edge-case register

| # | Situation | Behaviour |
|---|---|---|
| E-01 | Two tabs open on the same board, same user | Both work. Each is an independent session with its own socket. Presence shows one avatar (dedupe by user id) but two cursors. Acceptable |
| E-02 | Browser tab backgrounded for 30 min | The socket likely dies. On `visibilitychange` → visible, force a reconnect check immediately rather than waiting for the backoff timer |
| E-03 | User's clock is wrong | Never trust client timestamps for ordering. Server sequence numbers are the only ordering authority |
| E-04 | Object created at extreme coordinates | Clamp to ±1,000,000 on creation. Reject out-of-range coordinates server-side |
| E-05 | 50 MB image pasted | Reject before upload with a size error. Check `File.size` client-side first — do not upload and then fail |
| E-06 | Paste of non-image, non-CoBoard clipboard data | If it is plain text, create a text object at the pointer. Otherwise ignore silently |
| E-07 | User drags 500 objects at once | Batch into one op message. Throttle presence transforms harder (10 Hz) above 100 selected objects |
| E-08 | Rapid tool switching during a drag | Ignore tool changes while an interaction is in progress. Finish or cancel the interaction first |
| E-09 | `Escape` during a stroke | Cancel the stroke entirely. Nothing is committed, nothing is broadcast |
| E-10 | Window resized mid-drag | Recompute the canvas backing-store size, preserve the viewport centre, and keep the drag alive |
| E-11 | Zoomed to 500%, object is 2 px | Still hit-testable; handles have a minimum 8 px screen-space touch target regardless of zoom |
| E-12 | Zoomed to 10%, 5,000 objects | Cull off-screen objects; below 25% zoom, render strokes as simplified paths |
| E-13 | Server sends an op for an unknown object id | Log a warning, ignore the op, and request a fresh snapshot if this happens more than 3 times in a minute (it indicates divergence) |
| E-14 | Op arrives with seq ≤ lastAppliedSeq | Ignore. This is a duplicate |
| E-15 | Op arrives with seq > lastAppliedSeq + 1 | A gap. Buffer it and request the missing range. Do not apply out of order |
| E-16 | User double-clicks "New board" | The button disables on the first click. One board, not two |
| E-17 | Session expires while the board is open | The socket stays valid for its lifetime. Refresh the token silently in the background. If the refresh fails, keep the socket alive but show a banner: "Your session expired. [Log in again]" — never lose their work |
| E-18 | Browser blocks localStorage (private mode / cookies off) | Fall back to in-memory storage. The app works; preferences and the guest identity simply do not persist. Show no error |
| E-19 | Two users rename the board simultaneously | Last write wins. Both see the final name |
| E-20 | Very long display name in the presence pill | Truncate to 20 characters with an ellipsis; the full name shows on hover |
| E-21 | Slow 3G on board load | Snapshot request has a 30 s timeout, then an inline retry state. Never leave a spinner forever |
| E-22 | Board with 0 objects exported | Export a transparent 1×1 file? No — block it and toast: "There's nothing to export yet." |

---

# 13. Toast, modal, and focus conventions

## 13.1 Toasts

| Property | Rule |
|---|---|
| Position | Bottom-left on the board (so it never covers the properties panel); bottom-centre elsewhere |
| Max visible | 3. Older toasts collapse into "+2 more" |
| Duration | Info 3 s, success 3 s, error 6 s, error-with-action 8 s |
| Dismissal | Auto, or click ×, or `Escape` dismisses the topmost |
| Never use for | Anything requiring a decision. That is a modal |
| Accessibility | `aria-live="polite"` for info/success, `"assertive"` for errors |

## 13.2 Modals

| Rule | Detail |
|---|---|
| Focus trap | Tab cycles within the modal. Nothing behind is reachable |
| Initial focus | The first interactive element, or the primary action for confirmations |
| Return focus | To the element that opened it, always |
| `Escape` | Closes, unless a destructive action is mid-flight |
| Backdrop click | Closes non-destructive modals. Destructive confirmations require an explicit Cancel |
| Scroll lock | Body scroll is locked while a modal is open |
| Stacking | At most one modal at a time. Opening a second closes the first |
| Animation | Fade + 8 px rise, 200 ms. Respect `prefers-reduced-motion` |

## 13.3 Focus and keyboard on the board

- The canvas is focusable (`tabIndex=0`) so keyboard shortcuts have a home.
- Tab order: header → toolbar → canvas → properties panel → zoom controls.
- Shortcuts fire **only** when the canvas has focus or nothing focusable is focused.
- **Every** shortcut is suppressed while a text input, the on-canvas text overlay, or a modal has focus — except `Escape`.

---

# 14. The board canvas screen (S-10) — full layout specification

## 14.1 Desktop layout (≥ 1280 px)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ← │ Q3 Retrospective ▾ │  ● Connected     (P)(M)(D)+2  │ Export │ Share │ │  56px
├───┴────────────────────┴──────────────────────────────┴────────┴───────┴─┤
│┌──┐                                                              ┌──────┐ │
││V │                                                              │ Fill │ │
││H │                                                              │ ████ │ │
││P │                                                              │      │ │
││E │                  C A N V A S   A R E A                       │Stroke│ │
││R │                                                              │ ▬▬▬  │ │
││O │        (infinite, pannable, zoomable)                        │      │ │
││L │                                                              │Opacity│ │
││A │                                                              │ ───o─ │ │
││N │                                                              │      │ │
││T │                                                              │Layer │ │
││🖼│                                                              │ ⬆⬇   │ │
│└──┘                                                              └──────┘ │
│ 56px                                                                240px  │
│                                                        ┌────────────────┐ │
│  [undo][redo]                                          │ − 100% + [fit] │ │
└────────────────────────────────────────────────────────┴────────────────┴─┘
```

## 14.2 Region specification

| Region | Size | Contents | Notes |
|---|---|---|---|
| **Header** | Full width × 56 px | Back arrow, board title (editable, with a ▾ menu), connection indicator, presence avatars, Export, Share | Fixed. Never scrolls. `z-index: 30` |
| **Left toolbar** | 56 px × auto | Select, Hand, Pen, Eraser, Rect, Ellipse, Line, Arrow, Sticky, Text, Image | Vertically centred, floating with a shadow, 16 px from the left edge. `z-index: 20`. Each button has a tooltip: name + shortcut key |
| **Properties panel** | 240 px × auto | Context-sensitive to the active tool or the current selection | Floating right, 16 px from the edge. Hidden entirely when the Select tool is active with an empty selection. `z-index: 20` |
| **Canvas area** | Fills remaining space | The three stacked canvas layers | `z-index: 0`. See §14.3 |
| **Zoom controls** | ~180 × 40 px | `−`, percentage, `+`, zoom-to-fit | Bottom-right, 16 px margins. `z-index: 20` |
| **Undo/redo** | ~88 × 40 px | Undo, redo buttons, disabled when the corresponding stack is empty | Bottom-left. `z-index: 20` |
| **Toast area** | auto | Stacked toasts | Bottom-left, above undo/redo. `z-index: 40` |
| **Guest bar** | Full width × 48 px | Sign-up prompt for guests only | Pinned bottom. `z-index: 25` |
| **Modals** | — | Share, Settings, Export, Shortcuts | `z-index: 50` + backdrop at 45 |
| **Full-screen states** | Full viewport | S-17 / S-18 / S-19 | `z-index: 60` |

## 14.3 Canvas layer stack (bottom to top)

| Layer | Element | Contents | Redraw trigger |
|---|---|---|---|
| 0 | `<canvas id="grid">` `[P2]` | Dot grid | Viewport change only |
| 1 | `<canvas id="objects">` | All committed objects | Object create/update/delete, viewport change. **Not** on cursor movement |
| 2 | `<canvas id="interaction">` | The in-progress stroke, the marquee rectangle, drag previews, alignment guides | Every pointermove during an interaction |
| 3 | `<canvas id="overlay">` | Selection boxes, resize handles, remote cursors, remote selections, remote in-progress strokes | Every animation frame while presence is active |
| 4 | `<div id="text-overlay">` | The DOM textarea used for text editing | Only while editing text |

**The single most important performance rule in this project:** a remote cursor moving must never cause layer 1 to redraw. If moving a mouse in one window drops the frame rate in another, your layering is wrong.

## 14.4 Properties panel by context

| Active context | Panel contents |
|---|---|
| Select tool, nothing selected | Panel hidden |
| Pen tool | Colour swatches (10 + custom), thickness (5 presets + slider), opacity slider |
| Eraser | Eraser size indicator only |
| Rect / Ellipse | Fill colour (+ "none"), stroke colour, stroke width, opacity, corner radius (rect only) |
| Line / Arrow | Stroke colour, width, opacity, arrowhead style (start/end/both/none) |
| Sticky | 8 colour swatches, font size auto/manual toggle |
| Text | Font size, colour, bold, italic, alignment |
| Image | Opacity, corner radius, "Replace image", "Reset size" |
| Selection (single) | That object's full property set + z-order controls + Delete |
| Selection (multi, same type) | Shared properties + align/distribute `[P2]` + z-order + Delete |
| Selection (multi, mixed types) | Only universally shared properties (opacity, z-order, delete). Differing values show "Mixed" |
| Viewer role | Panel is replaced by a read-only badge: "👁 View only" |

## 14.5 Mobile layout (< 768 px)

```
┌──────────────────────────────┐
│ ← Q3 Retro    ● (P)(M) ⋯     │  48px header
├──────────────────────────────┤
│                              │
│                              │
│         CANVAS               │
│    (pinch zoom, 1-finger     │
│     pan when Select is       │
│     active and nothing is    │
│     selected)                │
│                              │
├──────────────────────────────┤
│  [V] [P] [N] [T] [⋯]   [↶][↷]│  56px bottom toolbar
└──────────────────────────────┘
```

Mobile differences:
- 5 primary tools; `⋯` opens a sheet with the rest.
- Properties open as a bottom sheet on selection.
- No marquee select (one-finger drag pans instead). Tap to select, long-press to multi-select.
- Handles are 44 px touch targets in screen space.
- The Share modal becomes a full-screen sheet.
- Text editing scrolls the canvas so the edited object sits above the keyboard.

---

# 15. Interaction state machines

## 15.1 Canvas interaction machine

This is the master state machine for pointer handling. Only one state is active at a time; illegal transitions are bugs.

```
                            ┌──────┐
              ┌────────────►│ IDLE │◄───────────────┐
              │             └──────┘                │
              │        pointerdown │                │
              │      ┌─────────────┼──────────┐     │
              │      │             │          │     │
       on empty+     │      on object    on handle  │
       select tool   │      +select tool      │     │
              ▼      │             ▼          ▼     │
        ┌──────────┐ │      ┌───────────┐ ┌────────────┐
        │MARQUEEING│ │      │ DRAGGING  │ │ RESIZING/  │
        └──────────┘ │      └───────────┘ │ ROTATING   │
              │      │             │      └────────────┘
      pointerup      │       pointerup          │ pointerup
              │      │             │            │
              └──────┼─────────────┴────────────┘
                     │
        with a draw tool active
                     ▼
              ┌────────────┐
              │  DRAWING   │──pointerup──► commit ──► IDLE
              └────────────┘
                     │ Escape / pointercancel
                     └──► discard ──► IDLE

        Space held (any state except DRAWING/text edit)
                     ▼
              ┌──────────┐
              │ PANNING  │──space released / pointerup──► previous state
              └──────────┘

        double-click on text/sticky, or place a new one
                     ▼
              ┌────────────┐
              │EDITING_TEXT│──Escape / blur──► commit ──► IDLE
              └────────────┘
```

**Rules:**
- Entering `PANNING` from `DRAWING` is forbidden. Space during a stroke does nothing.
- `pointercancel` (fired when the OS steals the pointer, e.g. a system gesture) must be handled identically to a cancel, never ignored. Forgetting this leaves the app stuck in `DRAGGING` forever.
- Every state that captures the pointer must release it on exit, including error paths.
- Tool changes are queued and applied on return to `IDLE`.

## 15.2 Connection state machine

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
      │              │  flush the outbox          │
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

Every state maps to exactly one header indicator (PRD FR-RT-009). The user always knows which state they are in without opening the console.

## 15.3 Object lifecycle

```
   (user action)
        │
        ▼
   ┌─────────┐  emit op   ┌──────────┐  server ack  ┌───────────┐
   │ DRAFTED │──────────► │ PENDING  │────────────► │ COMMITTED │
   └─────────┘            └──────────┘              └───────────┘
        │                       │                         │
   Escape/cancel          server reject              delete op
        │                       │                         │
        ▼                       ▼                         ▼
   ┌──────────┐           ┌──────────┐              ┌──────────┐
   │DISCARDED │           │ROLLED    │              │ DELETED  │
   │(no trace)│           │BACK      │              │(tombstone│
   └──────────┘           │+ toast   │              │ retained)│
                          └──────────┘              └──────────┘
```

Deleted objects keep a tombstone in memory for the session so that a late-arriving update for a deleted object can be correctly ignored rather than resurrecting it (see PRD FR-RT-007).

---

# 16. Flow index — quick reference

| Flow | Start | End | Section |
|---|---|---|---|
| New user signs up | S-01 | S-07 | §3 |
| Returning user logs in | S-03 | S-07 / deep link | §4 |
| Password reset | S-03 | S-03 | §5 |
| Create a board | S-07 | S-10 | §6.5 |
| Rename a board | S-07 / S-10 | same | §6.6 |
| Delete + restore a board | S-07 | S-08 → S-07 | §6.7, §6.8 |
| Guest joins via link | S-11 | S-10 | §7 |
| Guest converts to account | S-10 | S-10 (upgraded) | §7.4 |
| Draw a stroke | S-10 | S-10 | §8.2.1 |
| Place a sticky note | S-10 | S-10 | §8.2.2 |
| Select and transform | S-10 | S-10 | §8.2.3 |
| Pan and zoom | S-10 | S-10 | §8.2.4 |
| Undo / redo | S-10 | S-10 | §8.2.5 |
| Second user joins live | S-10 | S-10 | §9.1 |
| Disconnect and recover | S-10 | S-10 | §9.4 |
| Ejected from a board | S-10 | S-17/18/19 → S-07 | §9.5 |
| Share a board | S-10 ⤳ S-12 | S-10 | §10 |
| Export | S-10 ⤳ S-14 | S-10 | §11 |
