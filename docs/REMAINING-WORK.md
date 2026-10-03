# CoBoard — Remaining Work Plan

> Snapshot as of `7c55116` (Phase 10 merged). This is a working plan derived from
> [`04-IMPLEMENTATION-PLAN.md`](./04-IMPLEMENTATION-PLAN.md), cross-checked against
> what is actually in the tree. It does not replace that plan — task numbers below
> (`P11-T6` = Phase 11, task 6) point back to it. The four specification documents
> stay unedited (`R-PREC-020`).

## 1. Where we are

| Milestone          | Phases | State                                                        |
| ------------------ | ------ | ------------------------------------------------------------ |
| M1 — It draws      | 1–6    | ✅ Done                                                      |
| M2 — It persists   | 7–8    | ✅ Done                                                      |
| M3 — It syncs      | 9–10   | ✅ Done (`AT-01`–`AT-08`)                                    |
| M4 — It survives   | 11     | ✅ Done — see the Phase 11 outcome below                     |
| M5 — It's finished | 12–15  | ⬜ Not started (a few seams stubbed with "Phase N" comments) |

## 2. Already in the tree that Phase 11 builds on

Do not rebuild these — extend them.

- `features/sync/SocketClient.ts` — full-jitter `backoffFor` (`R-SYNC-030`), `join` with `sinceSeq`, a `ConnectionState` with the six states from `packages/shared/src/protocol.ts`.
- `features/sync/Outbox.ts` — queue, inflight, ack/nack, `localStorage` persistence with untrusted-input validation on restore. **Note:** it carries its own copy of `backoffFor`; consolidate into `backoff.ts`.
- `features/sync/persistence.ts` — flushes on `online`.
- `features/sync/SyncEngine.ts` — seq ordering and gap buffering.
- `features/presence/presenceStore.ts` — stale-entry sweep (not the reconnect desaturation).
- `components/board/ConnectionIndicator.tsx` — placeholder; its header comment says the full state set lands in Phase 11.
- `components/dev/CanvasDebugOverlay.tsx` — FPS overlay only; no state hash yet.

## 3. Known stubs to retire (grep `Phase 1[1-5]`)

| Where                                                               | Stub                                                   | Retired by    |
| ------------------------------------------------------------------- | ------------------------------------------------------ | ------------- |
| `components/board/ConnectionIndicator.tsx:8`                        | Partial states, no pending-change count                | P11-T9        |
| `components/dev/CanvasDebugOverlay.tsx:9`                           | No state hash (`R-CONV-011`)                           | P11-T14/15    |
| `tests/e2e/realtime.spec.ts:203`                                    | Latency instrumentation deferred                       | P11 / P15-T11 |
| `tests/e2e/realtime.spec.ts:392`, `server/http/routes/boards.ts:58` | Second user cannot join from the browser until sharing | P12-T4–T6     |
| `server/services/BoardService.ts:152`                               | `starred` filter has no `Star` model                   | P12           |
| `canvas/renderer/drawObjects.ts:22,67`, `Toolbar.test.tsx:107`      | Image placeholder rectangle (`FR-CANVAS-010`)          | P13-T7–T11 ¹  |
| `features/boards/BoardCard.tsx:105`                                 | Every card shows the no-thumbnail fallback             | P13-T12       |
| `App.tsx:67`                                                        | `/` is a signpost, no S-01 landing                     | P15 ²         |

¹ Code comments say "Phase 12"; the plan's task list puts presign/confirm/upload/`ImageObject` in Phase 13. Follow the plan; fix the comments when touched.
² Not in any phase's task list explicitly — see §6, question A.

## 4. The plan, phase by phase, in PR-sized slices

Each slice targets ~400 changed lines (`R-GIT-003`), lists its requirement IDs, and must meet the Definition of Done (CLAUDE.md §14).

### Phase 11 — Reconnection, outbox, gap fill, conflicts (M4) · Sync owner

**Detailed plan, written after reading the code (supersedes the first-pass table).**

The survey turned up more than the original table assumed. Backoff, outbox persistence, `sinceSeq` rejoin, the gap fill and the `online` flush already exist. Three **convergence bugs** also exist, and the convergence harness would expose all of them. They are fixed first because the rest of the phase cannot be verified while they stand.

#### Defects found in the survey

| #   | Defect                                                                                                                                                                                                                                                                                                                                 | Rule                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| F-1 | **Remote ops overwrite unacked local writes.** The server leaves the sender out of the broadcast, so a remote `UPDATE` to field _f_ ordered **before** my pending write to _f_ is applied on top of mine. I show theirs and everyone else shows mine. The client must hold its own pending fields until they are acked, as Figma does. | `R-CONV-001`, `R-CONV-006` |
| F-2 | **A local DELETE tombstones at `MAX_SAFE_INTEGER` forever.** When a teammate's undo later re-creates the object (higher seq), every other client shows it and mine never does. The tombstone must drop to the seq in the ack.                                                                                                          | `R-CONV-003/004`           |
| F-3 | **A nack only toasts.** The object stays on screen and the undo entry stays on the stack. CLAUDE.md §3.2 step 6b requires removing the change locally and removing its undo entry.                                                                                                                                                     | `R-SYNC-011`, P11-T7       |
| F-4 | **An offline replay is rate-limit-nacked.** The outbox sends 100-op batches back to back against a 100 ops/s bucket, so ops 101–500 of a long offline session are nacked, and nacks are never retried. That is silent data loss. The client must pace itself to the server's budget.                                                   | `FR-RT-012`, `R-SEC-013`   |
| F-5 | **A server persist failure is nacked as `INVALID_OP`.** The comment beside it says "the client keeps the ops and retries", but a nack makes the client drop them. A transient DB error must not be reported as a decision.                                                                                                             | `R-SYNC-012`               |
| F-6 | **`SYNCING` ends at `join_ack`**, not when the outbox has drained, and the outbox is not resumed on reconnect. After a drop it waits for the 10 s ack timeout and then its own backoff before replaying.                                                                                                                               | FLOWS §15.2                |

#### Slices

| PR  | Scope                                                                                                                                                                                                                                                                                                                                                         | Tasks / defects         | Proves                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| 11a | `stateHash.ts` (sorted by id, keys sorted, floats to 2 dp, FNV-1a) and a convergence section in the `?debug=1` panel: `lastAppliedSeq`, `objects.size`, hash, outbox pending, connection state                                                                                                                                                                | T14, T15                | Unit: stable across insertion order, key order and float noise                            |
| 11b | `pendingWrites.ts`: track the fields each unacked local op touches; drop those fields from remote ops; an echoed own op (catch-up) counts as an ack. Lower the tombstone of my own DELETE to its acked seq. Nack rollback: restore base values, remove the undo entry, one toast per batch                                                                    | F-1, F-2, F-3, T7       | Unit: the interleavings that diverged before, now converge; nack restores and drops entry |
| 11c | `backoff.ts` (one copy); `ConnectionMachine.ts` (a pure transition table, illegal transitions refused); `SYNCING` held until the outbox drains; on close, in-flight batches reject at once and requeue at the front; outbox resumes on rejoin; immediate retry on `online`, `visibilitychange` → visible (`E-02`) and manual retry; `offline` event → OFFLINE | T1, T2, T4–T6, T13, F-6 | Unit: backoff range, transition table, requeue order                                      |
| 11d | Outbox pacing to `RATE_LIMIT_OPS_PER_SEC` in batches of `OUTBOX_FLUSH_BATCH_SIZE`. Server: a persist failure sends no nack. Re-verify never-retry-a-nack, `E-18` and restore-on-load with tests                                                                                                                                                               | T3, T11, T12, F-4, F-5  | Unit: 500-op replay is never rate-limited; socket integration: DB failure → no nack       |
| 11e | `ConnectionIndicator`: five states, verbatim copy, attempt counter, syncing count, "Retry now". `OfflineBanner` at 500 ops or 10 min. "Back online — N changes synced" toast. Presence goes stale (desaturated) while not connected                                                                                                                           | T9, T10, T17            | Component tests; `FR-RT-009`                                                              |
| 11f | Playwright: `driveRandomOperations.ts` (seeded PRNG, 200 ops over two contexts) + `convergence.spec.ts`; chaos specs `AT-12`, `AT-30`–`AT-35` and offline merge. A dev-only socket kill switch, since Playwright's `setOffline` does not close an open WebSocket                                                                                              | T16                     | **Exit gate**                                                                             |

**Interim positions taken** (flag in the PR, per Appendix P): `Q-2`: soft warning at 10k objects, hard cap at 50k. This slice adds no enforcement, because none is specified for Phase 11.

**Ownership heads-up (`R-ARCH-006`):** 11b touches `features/canvas/history` (interaction owner) to remove nacked undo entries.

Exit gate: `AT-12`, `AT-30`–`AT-35` pass; the convergence harness passes on repeated runs; the debug panel shows matching hashes on two clients.

#### Phase 11 outcome

All six slices landed. The convergence harness found five more defects after the plan was written, and all are fixed with regression tests:

| #    | Defect                                                                                                                                                                                                                                                              | Found by                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| F-7  | Ops restored from storage after a reload were flushed but never applied locally, so the user's own offline work was invisible until the next reload                                                                                                                 | Survey                   |
| F-8  | Ops appended over REST (the outbox fallback) were persisted and acked but never broadcast                                                                                                                                                                           | e2e harness              |
| F-9  | Held fields were released at the ack. Broadcasts are batched for 16 ms and acks are not, so an ack overtook an older remote write, which then landed on top. Fields are now released when the document reaches the op's seq; own acks are ordering markers          | e2e harness              |
| F-10 | E-13 counted updates to deleted objects as "unknown", so it reloaded constantly; and its reload replayed one page of the log, wiped unacked edits and dropped ops that arrived mid-fetch. Now tombstones are known and the reload is a held, snapshot-based replace | e2e harness + wire trace |
| F-11 | Concurrent undo of a delete: remote ops were applied over a pending local re-create, and a remote re-create overwrote pending local fields                                                                                                                          | e2e harness + wire trace |

**Evidence.** The convergence spec passed 10/10. The whole Phase 11 spec (2 convergence seeds, `AT-30`–`AT-35`, offline merge, `AT-12`) passed 30/30 over three repeats. The full e2e suite: 135 passed and 1 failed (`dashboard.spec.ts` S-08, a dropdown that did not open under parallel load; it passed 27/27 when run alone and is unrelated to sync); 3 did not run.

**Caveats.**

- `AT-12` is approximated: every socket is cut at once mid-session. A real server restart cannot be driven from inside the suite, because Playwright owns the server process. Server durability across a restart rests on persist-before-ack, which the socket integration suite covers.
- The convergence and chaos specs register an account each. Running them many times in one 15-minute window hits the per-IP signup limit (429). That limit belongs to the environment, not the code.
- Known flake to fix separately: the S-08 dashboard dropdown under load.

### Phase 12 — Sharing, guest flow, permission enforcement (M5) · Product owner

**Detailed plan, written after reading the code (supersedes the first-pass table).**

#### What exists, and what is missing

- `BoardMember` has `userId` only: no guests, no `ShareLink` model, no invites.
- `PermissionService.resolve` knows owner and members, with no cache.
- `GET /boards/:id/access` exists, but only for signed-in users, and it never reports `joinable`.
- Every authenticated route uses `requireAuth`, so a guest cannot call any API.
- The `Mailer` abstraction exists (`LoggingMailer`).

#### Defects found in the survey

| #   | Defect                                                                                                                                                                                                                                                                                           | Rule                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| P-1 | **The socket checks a role frozen when the ticket was issued.** `handleOps` reads `session.role`, which is set at upgrade time. A member demoted to viewer, or removed, keeps editing until they reconnect. The check must re-resolve the role (cached, invalidated on change) on every op batch | `R-SEC-001`, TRD §11.2   |
| P-2 | **Viewer mode is a badge, not a mode.** The toolbar and every pointer and keyboard edit path still work for a viewer. The server refuses the ops, so each edit flashes in and is rolled back                                                                                                     | `FR-SHARE-006`           |
| P-3 | **Presence carries `guestId`.** `PresenceUser.guestId` is broadcast to the room. If the guest id is the guest's credential, broadcasting it hands that credential to everyone in the room. The server must never send it                                                                         | `R-SEC-001`, `R-SEC-005` |

#### Decisions taken (flagged per the ambiguity rule; reversible)

| #   | Decision                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1 | **Guest credential.** The guest id is a client-generated `crypto.randomUUID()` (122 random bits), stored in `localStorage.coboard.guest` as FR-AUTH-006 specifies, and sent as an `x-coboard-guest` header. It is a bearer secret, so the server never echoes it to anyone else (P-3), and member lists show guests by name only     |
| D-2 | **`Q-1` interim:** guests persist as `BoardMember` rows (FLOWS §10.3). The 24-hour idle sweep is deferred to Phase 15 ops work                                                                                                                                                                                                       |
| D-3 | **One live share link per board.** `ShareLink.revokedAt` marks old ones. Guest members record `shareLinkId`. Turning the link off or resetting it removes and ejects the guests who came through it (FLOWS §10.2 "ejects link-based guests"). Signed-in users who open a link become ordinary members with the link's role, and stay |
| D-4 | **Invites by email** go through the existing `Mailer` (it logs in development; there is no mail provider in the repo). Unregistered addresses get a `BoardInvite` row, claimed automatically when that email signs up                                                                                                                |
| D-5 | **Analytics.** There is no analytics module. Add a minimal `track(event, props)` seam (a dev-console sink) and wire this phase's four events. The real sink is Phase 14 task 18                                                                                                                                                      |
| D-6 | **Live ejection is pushed to sockets on the instance that made the change.** Enforcement itself is instance-independent, because every op re-checks the Redis-cached role (P-1). Cross-instance push is a Phase 15 scaling item                                                                                                      |

#### Slices

| PR  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                | Tasks / defects        | Proves                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| 12a | Migration: guest fields + `shareLinkId` on `BoardMember`, `ShareLink`, `BoardInvite`. An `Identity` (user or guest) resolved by an `identify` middleware. `PermissionService.getRole(boardId, identity)` with a 60 s Redis cache and `invalidate`. `assertCanEdit` on every op batch instead of `session.role`. Board rename/delete stay owner-only                                                                  | T1–T3, P-1             | Integration: AT-20 (forged viewer op nacked, nothing written), AT-24, demoted-mid-session      |
| 12b | Share link get/create/update/off/reset (32 CSPRNG bytes, base64url). Public `GET /share/:token`, `POST /share/:token/join` (name 1–40, room-full 403). `/access` implements the full STEP 4 table for user, guest and share token. Guests can get a ws ticket and read and write the board their role allows. Presence never carries `guestId`                                                                       | T4–T7, T20, P-3        | Integration: every `/access` branch; revoked link fails at once; guest ticket                  |
| 12c | Members list/add/update/remove/leave; invites (claimed at signup); live `role_changed` / `access_revoked` / `board_deleted` pushes, with in-memory session roles updated and revoked sockets closed; link off/reset ejects that link's guests                                                                                                                                                                        | T15, T16, T17 (server) | Integration: each endpoint, including authorization failures; live ejection over a real socket |
| 12d | Client: `guestIdentity.ts` (with the E-18 fallback), the guest header in `api.ts`, `RequireBoardAccess` (shell first, then the six branches), S-11 `/join/:token` (failure branches, 40-character counter from 30, `replace: true`), returning-guest skip + "Joined as … — Not you?" chip, viewer mode (toolbar → Phosphor `Eye` badge; every edit path blocked; live `role_changed` toast), S-17/S-18/S-19 ejection | T8–T11, T17–T19, P-2   | Component tests; e2e AT-21                                                                     |
| 12e | S-12 share modal: email chips (invalid chips block Send), members with optimistic role change and revert, Remove, general access (Restricted / Anyone, can edit / can view), Copy → "Copied!" with the read-only-input fallback, Reset link with confirmation                                                                                                                                                        | T14, T15 (UI)          | Component tests                                                                                |
| 12f | Guest bar (7-day dismissal) + conversion through a new tab and `postMessage` (canvas kept, guest upgraded to Editor); `track()` with `board_opened`, `board_joined_as_guest`, `share_link_created`, `share_link_copied`; e2e AT-22, AT-23, guest join in < 10 s, returning guest, role change without ejection, conversion; replace the `realtime.spec.ts` workaround                                                | T12, T13, T21          | **Exit gate**                                                                                  |

**Ownership heads-up (`R-ARCH-006`):** 12d touches `features/canvas/interaction` (interaction owner) to block edit paths for viewers.

Exit gate: guest joins in < 10 s; `AT-20`–`AT-24` pass; a viewer cannot mutate the board even with a forged socket message; revocation and deletion eject connected users with the correct screens.

#### Phase 12 outcome

All six slices landed, and P-1, P-2 and P-3 are fixed with tests. Problems found while building:

| #   | Finding                                                                                                                                                              | Fix                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P-4 | Live pushes went to the wrong room registry when two gateways ran in one process (the fan-out test). The second gateway took over `liveRooms` and never gave it back | The gateway restores the previous rooms on close              |
| P-5 | A returning guest got the first-join "You're in as" toast instead of the "Not you?" chip                                                                             | The auto-join path passes `returning` and no `joinedAs` state |
| P-6 | The viewer toast fired twice under StrictMode, because the side effect ran inside a state updater                                                                    | Moved out of the updater (`roleRef`)                          |
| P-7 | The guest-identity memory fallback answered even when storage worked but was empty                                                                                   | Memory is used only when storage throws (E-18)                |

**Evidence.**

- Unit and integration: 1010/1010.
- Server integration covers AT-20 (a forged viewer op is nacked and nothing is written), AT-24, demotion and removal mid-session, every `/access` branch, every member and share endpoint including the authorization failures, and live ejection over a real socket.
- e2e: `sharing.spec.ts` passed 21/21 over three repeats. A guest's first stroke reaches the owner in about 1.8 s from the page load, against a target of under 10 s. The spec also covers the returning guest, AT-20, a live role change without ejection, AT-22, AT-23 and the guest → account conversion.
- AT-21 lives in `board-persistence.spec.ts`.
- Full e2e suite: 146/146.

#### Phase 12 follow-up (12g): the caveats, done to spec

Each caveat above was checked against the specs and fixed rather than left as an interpretation. Three were real defects, not just open questions:

| #    | Was                                                                                                     | Now                                                                                                                                                                                                      | Source                    |
| ---- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| P-8  | **Defect.** Only `Fanout.publish` crossed instances; op batches, presence and live pushes stayed local  | `RoomManager` takes a `Relay`; broadcasts, flushed op batches and live permission changes go local + Redis. `join_ack` lists users on other instances from the presence hash. Supersedes D-6             | TRD §15.2, CLAUDE.md §3.2 |
| P-9  | **Defect.** Two simultaneous refreshes with one token both rotated: one secret became two live sessions | The revoke is conditional on the row still being live; the loser is reuse. The client serializes refreshes across tabs with a Web Lock, so two tabs no longer sign each other out                        | R-SEC-006                 |
| P-10 | **Defect.** `BoardGrid` swapped live cards for the lazy animated grid, remounting every card            | The fallback is the skeleton; the chunk preloads with the dashboard. This was the S-08 flake: an open menu closed, focus fell to `<body>`, an inline rename was lost                                     | —                         |
| —    | An anonymous visitor with no link was sent to log in                                                    | S-17 per the FLOWS §2.4 tree (S-18 for a missing or deleted board), with the §12.1 account line: "Signed in as … — Switch account", or Log in with `?next=` so deep links still survive login (FLOWS §4) | FLOWS §2.4, §12.1         |
| —    | Reset link confirmed inline                                                                             | A real confirmation modal. `Modal` is stack-aware: only the topmost answers Escape and traps Tab                                                                                                         | FLOWS §10.2               |
| —    | Guests were never dropped (D-2 deferral)                                                                | Hourly sweep: guests go once the board has had no op and no guest visit for 24 h and nobody is connected on any instance                                                                                 | FLOWS §10.3               |
| —    | Google sign-up from the guest bar did not convert the board tab                                         | The signup tab marks itself before leaving for Google; `/auth/callback` announces over `BroadcastChannel`, which needs no `window.opener`                                                                | FLOWS §7.4                |

**Evidence.** Unit and integration 1020/1020, including a cross-instance test (ops, presence, `join_ack` users and a live revoke reach a socket on a second instance) and a concurrent-refresh test that fails before the fix. The full e2e suite passes, 147/147. The new two-tab test fails with the Web Lock removed and passes with it. Dashboard + sharing ran 51/51 under parallel load, three repeats each.

**Still open:**

- **Copy gaps.** PRD §8 gives only the headlines for the dead-link and deleted-board screens. The bodies in `strings.ts` (`states`) are interim, commented as copy gaps, and need product copy.
- **Signup rate limit in tests.** Running the sharing spec many times in one 15-minute window exhausts the per-IP signup limit, and the conversion test then fails with "Too many attempts". That limit belongs to the environment, not the code.
- **Colours across instances.** Presence colours are round-robin per instance. With two instances, two people can draw the same colour. Single-instance v1 is unaffected; this belongs with Phase 15 scaling.

### Phase 13 — Export, images, thumbnails, trash, duplicate (M5) · Product owner

**Detailed plan, written after reading the code (supersedes the first-pass table).**

#### What exists, and what is missing

- **Duplicate** (FR-BOARD-007) works end to end, on the server and from the card menu, with an e2e test. Nothing is missing except the thumbnail, which a copy should carry.
- **Trash** (FR-BOARD-006): the list, days remaining, Restore and the typed-name permanent delete all work and are tested. Missing:
  - the row thumbnail the plan's UI workstream lists;
  - copy for "Deleted …", "N days left" and the delete dialog, which is inlined rather than in `strings.ts` (R-UI-052);
  - the restore collapse motion.
  - **`BoardService.purgeExpiredTrash` exists, but nothing ever calls it**: boards stay in Trash forever.
- **Thumbnails** (FR-BOARD-003): `Board.thumbnailUrl` and the card's `<img>` / placeholder exist. Nothing generates a thumbnail, and there is no endpoint to store one.
- **Images** (FR-CANVAS-010): `ImageObjectSchema` exists (a URL, never base64). The renderer still draws images as a grey blockout box, the toolbar's Image button is disabled, and there is no upload path, no storage client, no magic-byte check and no SVG sanitizer.
- **Export** (FR-EXPORT-001): nothing.
- **Storage**: `.env.example` has `S3_*` keys, but `env.ts` ignores them. No S3 is reachable from this container, and the network policy blocks the MinIO download, so development and tests use **s3rver** (an npm S3 emulator).

#### Decisions taken (flagged per the ambiguity rule; reversible)

| #     | Decision                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D13-1 | **`POST /uploads/presign` also takes `boardId`.** TRD §4.4's body is `{filename, contentType, size}`. Without a board, the server cannot authorize the upload (R-SEC-001 on every request). With one, it requires edit rights on that board and keys the object under `boards/{boardId}/`. `confirm` re-checks the key prefix against the caller's rights                                           |
| D13-2 | **Objects are public-read under unguessable keys** (`boards/{boardId}/{uuid}.{ext}`). The op stores a plain URL (FR-CANVAS-010), so the URL must load for every member, guest and later viewer without a signed-URL refresh path. The bucket needs CORS for `GET` and `PUT` from `CLIENT_ORIGIN`, and images load with `crossOrigin="anonymous"`, or export and thumbnails would taint their canvas |
| D13-3 | **Dev and test storage is s3rver.** It speaks the S3 API the real client uses, but it **does not verify presigned signatures**. The tests therefore prove our validation, not S3's signature enforcement. Production points `S3_ENDPOINT` at real S3 or MinIO                                                                                                                                       |
| D13-4 | **Thumbnails are PUT through the server**, not presigned. A 640×400 JPEG at 0.7 is about 30 KB; the body is capped at 512 KB and checked for JPEG magic bytes. D-12 exists to keep large uploads off the event loop, and this is not one. An empty board **clears** its thumbnail, so the dashboard shows the static placeholder graphic                                                            |
| D13-5 | **Image placement**: at the drop point for drag-and-drop; at the viewport centre for paste and the toolbar. Natural size, scaled down to fit 60% of the viewport at the current zoom                                                                                                                                                                                                                |
| D13-6 | **Export scopes**: whole board, selection and visible area, as the plan and FLOWS §11 list. The PRD names only the first two. SVG appears as a disabled `[P2]` option, as the FLOWS §11 drawing shows                                                                                                                                                                                               |

#### Slices

| PR  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Tasks      | Proves                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13a | Server storage + uploads: `lib/s3.ts` (AWS SDK v3, presign PUT with exact content type and length), `lib/fileType.ts` (magic bytes for PNG, JPEG, GIF, WebP and SVG), `lib/svgSanitize.ts` (DOMPurify on jsdom: no script, no `on*`, no external refs). `routes/uploads.ts`: presign (type, size, edit right, 20/h per user) and confirm (exists, magic bytes match the declared type, SVG rewritten sanitized; anything else deleted). s3rver wired into dev, tests and Playwright | T7, T8     | Integration: oversized and disallowed types refused before a URL is issued; a renamed executable refused; SVG stripped of `<script>`, handlers and external refs; viewer refused |
| 13b | Client images: `imageCache.ts` (LRU 100, `crossOrigin="anonymous"`, redraws the object layer on load), `shapes/image.ts` (draws the image; while loading or failed, a neutral box), blockout branch removed                                                                                                                                                                                                                                                                         | T11        | Unit: LRU eviction order and the cap; a load marks the layer dirty                                                                                                               |
| 13c | Client upload: `features/uploads/useUpload.ts` (E-05 size and type checked before any request → presign → XHR PUT with progress → confirm → CREATE op), drag-and-drop, paste, toolbar button with a file input; `UploadPlaceholder` DOM overlay with a linear progress ring, "Upload failed." with Retry and Remove. Blocked for viewers                                                                                                                                            | T9, T10    | Component: oversize and unsupported files toast the PRD §8.2 copy and never request; failure → Retry works. e2e: drop a PNG and the other window sees it                         |
| 13d | Export S-14: `features/export/renderToCanvas.ts` (bounds per scope + padding; 8192² clamp with warning; above 2,000 objects, rAF-yielding chunks with progress), `download.ts` (slug, date, 60 s revoke), `ExportModal` (scope, format, scale, background, padding, live preview with 150 ms crossfade), toolbar Export + Cmd+Shift+E, E-22 block, `export_completed`. `drawObjects` gains a no-clear option (heads-up: renderer owner)                                             | T1–T6, T16 | Unit: bounds per scope, the clamp, slugify (unicode, punctuation). Component: empty board blocked with the toast. e2e: a downloaded PNG has the right size at 1× and 2×          |
| 13e | Thumbnails: `features/canvas/thumbnail.ts` (640×400 JPEG 0.7, bounding box + 5%), `PUT/DELETE /boards/:id/thumbnail` (editors), generated on session end and every 5 minutes of active editing; the empty-board placeholder graphic. Trash: row thumbnail, copy into `strings.ts`, restore collapse; trash purge on the maintenance timer. Duplicate carries the thumbnail                                                                                                          | T12–T15    | Integration: thumbnail auth + magic bytes; purge removes only expired boards. Component: delete confirm disabled until the exact name. e2e: a card shows its thumbnail           |

**Ownership heads-up (`R-ARCH-006`):** 13b and 13d touch `features/canvas/renderer` (renderer owner): the image draw path, and a no-clear option on `drawObjects` for chunked export.

Exit gate: export produces a correct PNG at both scales for all three scopes; uploads work end to end with sanitization; thumbnails appear on dashboard cards; trash restore and permanent delete work; every P0/P1 feature exists.

### Phase 14 — States, responsive, accessibility, polish (M5)

Split into roughly six PRs: **(a)** `strings.ts` completion and inlined-string sweep + five empty states; **(b)** S-19/20/21, two error boundaries, correlation IDs; **(c)** toast + modal system completion, focus management, shortcut suppression, S-15 shortcuts modal; **(d)** breakpoints 1024/768 + mobile layout; **(e)** a11y pass, reduced-motion verification, unsupported-browser screen; **(f)** the `E-01`–`E-22` verification checklist, `emil-design-eng` motion review (table format, `R-SKILL-072`) and analytics for all 14 PRD §9 events.

### Phase 15 — Performance, e2e, deployment, monitoring (M5)

**(a)** Profiling at 5k/10k objects, style batching, code splitting, bundle budgets; **(b)** 30-minute memory test and leak fixes; **(c)** complete Playwright `AT-01`–`AT-44`, five must-write tests, Lighthouse CI, p95 input-to-remote instrumentation; **(d)** load test (50 users, 100 ops/s); **(e)** deployment, backups with a tested restore, monitoring for the eight signals, structured logging; **(f)** manual QA checklist and cross-browser stroke check. S-01 landing slots here if §6-A is answered "yes".

## 5. Sequencing and critical path

```
11a ─► 11b ─► 11c ─► 11d ─► 11e ─► 11f   (M4 gate)
                                   │
                12a ─► 12b ─► 12c ─► 12d
                         └──► 12e ─► 12f  (needs 11d for ejection on reconnect)
                13b ─► 13c         13a, 13d   (13a/13d independent of 12)
                                   14a … 14f ─► 15a … 15f
```

- 11a first: the hash is the divergence oracle for everything after it (`R-1`, `R-CONV-011`).
- 12a can start in parallel with 11e/11f (different owner, server-side only).
- 13a (export) and 13b (upload server) touch no sync code and can run alongside Phase 12.
- Phase 14 should not start until 12/13 screens exist — it polishes them.

## 6. Decisions needed before work starts (per the ambiguity rule, `A-80`)

| #   | Question                                                                                                                                             | Blocks   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A   | **S-01 landing page** has no task in any phase list (only the `App.tsx:67` comment says "Phase 15"). Confirm it is in scope and which phase owns it. | Phase 15 |
| B   | **Image upload**: code comments say Phase 12, plan tasks say Phase 13. Confirm Phase 13.                                                             | 13b/13c  |
| C   | **`Q-2` object cap** is due at Phase 11. Proceed on the interim position (soft 10k, hard 50k)?                                                       | 11d      |
| D   | **`Q-1` guest persistence** was due at Phase 10 and is still unratified. Proceed on the interim (rows kept, swept after 24 h idle)?                  | 12b, 12f |
| E   | **S3 in dev**: `docker-compose.yml` has Postgres + Redis only. Add MinIO for local uploads?                                                          | 13b      |
| F   | `Q-3`/`Q-4`/`Q-5` — due Phase 14; interim positions (chrome-only dark mode, fixed 30 days, Inter everywhere) apply unless overruled.                 | Phase 14 |
