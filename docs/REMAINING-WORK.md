# CoBoard — Remaining Work Plan

> Started at `7c55116` (Phase 10 merged) and kept current through Phase 15 and the
> post-Phase-15 audit (see §7). This is a working plan derived from
> [`04-IMPLEMENTATION-PLAN.md`](./04-IMPLEMENTATION-PLAN.md), cross-checked against
> what is actually in the tree. It does not replace that plan — task numbers below
> (`P11-T6` = Phase 11, task 6) point back to it. The four specification documents
> stay unedited (`R-PREC-020`).

## 1. Where we are

| Milestone          | Phases | State                                                     |
| ------------------ | ------ | --------------------------------------------------------- |
| M1 — It draws      | 1–6    | ✅ Done                                                   |
| M2 — It persists   | 7–8    | ✅ Done                                                   |
| M3 — It syncs      | 9–10   | ✅ Done (`AT-01`–`AT-08`)                                 |
| M4 — It survives   | 11     | ✅ Done — see the Phase 11 outcome below                  |
| M5 — It's finished | 12–15  | ✅ Done — see each phase's outcome below and the §7 audit |

## 2. Already in the tree that Phase 11 builds on (historical)

> Kept as written at the Phase 11 start. Everything below has since been extended as planned.

Do not rebuild these — extend them.

- `features/sync/SocketClient.ts` — full-jitter `backoffFor` (`R-SYNC-030`), `join` with `sinceSeq`, a `ConnectionState` with the six states from `packages/shared/src/protocol.ts`.
- `features/sync/Outbox.ts` — queue, inflight, ack/nack, `localStorage` persistence with untrusted-input validation on restore. **Note:** it carries its own copy of `backoffFor`; consolidate into `backoff.ts`.
- `features/sync/persistence.ts` — flushes on `online`.
- `features/sync/SyncEngine.ts` — seq ordering and gap buffering.
- `features/presence/presenceStore.ts` — stale-entry sweep (not the reconnect desaturation).
- `components/board/ConnectionIndicator.tsx` — placeholder; its header comment says the full state set lands in Phase 11.
- `components/dev/CanvasDebugOverlay.tsx` — FPS overlay only; no state hash yet.

## 3. Known stubs to retire (grep `Phase 1[1-5]`) — all retired

> Each row was retired by the phase named in its last column; the outcomes below record how. The `starred` filter has no Star model by design (stars are P2), so it returns no boards (D-34); see §7.

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

| #     | Decision                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D13-1 | **`POST /uploads/presign` also takes `boardId`.** TRD §4.4's body is `{filename, contentType, size}`. Without a board, the server cannot authorize the upload (R-SEC-001 on every request). With one, it requires edit rights on that board and keys the object under `boards/{boardId}/`. `confirm` re-checks the key prefix against the caller's rights                                                             |
| D13-2 | **Objects are public-read under unguessable keys** (`boards/{boardId}/{uuid}.{ext}`). The op stores a plain URL (FR-CANVAS-010), so the URL must load for every member, guest and later viewer without a signed-URL refresh path. The bucket needs CORS for `GET` and `PUT` from `CLIENT_ORIGIN`, and images load with `crossOrigin="anonymous"`, or export and thumbnails would taint their canvas                   |
| D13-3 | _(Superseded in Phase 13: s3rver was not adopted; dev and e2e use the in-process `apps/server/src/dev/fakeS3.ts`, which does verify SigV4 signatures.)_ **Dev and test storage is s3rver.** It speaks the S3 API the real client uses, but it **does not verify presigned signatures**. The tests therefore prove our validation, not S3's signature enforcement. Production points `S3_ENDPOINT` at real S3 or MinIO |
| D13-4 | **Thumbnails are PUT through the server**, not presigned. A 640×400 JPEG at 0.7 is about 30 KB; the body is capped at 512 KB and checked for JPEG magic bytes. D-12 exists to keep large uploads off the event loop, and this is not one. An empty board **clears** its thumbnail, so the dashboard shows the static placeholder graphic                                                                              |
| D13-5 | **Image placement**: at the drop point for drag-and-drop; at the viewport centre for paste and the toolbar. Natural size, scaled down to fit 60% of the viewport at the current zoom                                                                                                                                                                                                                                  |
| D13-6 | **Export scopes**: whole board, selection and visible area, as the plan and FLOWS §11 list. The PRD names only the first two. SVG appears as a disabled `[P2]` option, as the FLOWS §11 drawing shows                                                                                                                                                                                                                 |

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

#### Phase 13 outcome

All five slices landed. Defects and gaps found on the way:

| #   | Finding                                                                                                                                                                                    | Fix                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| I-1 | **The Redis token bucket expired every key after 60 s.** An expired key reads as a full bucket, so a 20-per-hour upload limit would have handed back all 20 tokens after a minute of quiet | The key's TTL follows the bucket's own full-refill time                                                      |
| I-2 | **`purgeExpiredTrash` existed but nothing called it**: boards stayed in Trash forever, against FR-BOARD-005/006                                                                            | Runs on the hourly maintenance timer, with each purged board's thumbnail deleted                             |
| I-3 | `.env.example` lists optional keys with empty values; `S3_ENDPOINT=` would have failed URL validation and stopped the server starting                                                      | `loadEnv` treats an empty value as unset                                                                     |
| I-4 | Cmd+V called `preventDefault`, which suppresses the browser's `paste` event, the only place an image copied from the OS arrives                                                            | Cmd+V lets the event through; an image in it claims the keystroke and the object paste stands down           |
| I-5 | Deleting a board's uploaded images on permanent delete would break other boards: paste and Duplicate share images by URL                                                                   | Images are never deleted with a board. Thumbnails, which no op refers to, are deleted; Duplicate copies them |

**Evidence.**

- Unit and integration: 1084/1084.
- Uploads (`uploads.integration.test.ts`, 17 tests, against an HTTP S3 stand-in through the real AWS SDK):
  - type and size refused before any URL is issued;
  - viewer and stranger refused;
  - 20 per hour, then 429;
  - a renamed executable rejected by its bytes and deleted;
  - real bytes of the wrong type rejected;
  - SVG stripped of script, handlers, `<style>`, `foreignObject` and external refs, while keeping `url(#g)`;
  - a key on another board refused;
  - thumbnail auth, magic bytes and replacement;
  - Duplicate's own copy of the thumbnail;
  - permanent-delete cleanup;
  - the purge removes only boards over 30 days.
- e2e:
  - `images.spec.ts`: a picked PNG reaches the other window as a storage URL that loads cross-origin; an 11 MB file is refused with no request made.
  - `export.spec.ts`: real downloads, with sizes read from the PNG header for all three scopes at 1× and 2×, on a board that includes an uploaded image (so the canvas is untainted). E-22 blocks an empty export. 2,500 objects export in chunks with a progress bar; the longest main-thread task was 0–70 ms over the runs.
  - `thumbnails.spec.ts`: leaving a board you drew on puts a 640×400 picture on its dashboard card; an empty board keeps the placeholder graphic.
  - The three specs passed 21/21 over three repeats. The full suite: 154/154.

**Interpretations and caveats.**

- D13-1 … D13-6 above stand: presign takes `boardId`; objects are public-read under unguessable keys; development storage is a fake S3; thumbnails go through the server; placement and scopes as stated.
- **The fake S3 does not verify signatures.** Presign enforcement (expiry, content type, length) is proven only against real S3 or MinIO, which this container cannot reach: the network policy blocks the MinIO download. Production needs the bucket's CORS (GET and PUT from `CLIENT_ORIGIN`) and public-read objects.
- **Uploaded images are never garbage-collected.** Deleting them safely needs a reference scan across every board's objects; that is storage-lifecycle work for Phase 15.
- **No object type renders `rotation` yet**, images included. This predates Phase 13 and is unchanged.
- The trash restore animation is opacity only. The motion table's "collapse" would animate height, which R-MOTION rules out.
- The 8192² clamp limits the AREA, as FLOWS §11 words it ("pixel count"). A very long, thin board can still produce one side longer than 8192 px.
- Copy gaps, marked interim in `strings.ts`: the SVG `[P2]` tooltip, and the export progress wording.
- `pnpm audit` still reports one high: `braces`, through Tailwind 3's file watcher. It was already present before this phase and has no patched release. js-yaml, undici and brace-expansion are now forced to patched versions; s3rver was not adopted because of its unpatched `dicer`.

#### Phase 13 follow-up: the caveats, fixed

| #    | Was                                                                                                                                                      | Now                                                                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-6  | **Defect.** No object type rendered `rotation`. Hit testing and the rotate handle honoured it, so a rotated object drew upright inside a rotated hit box | `drawObjects` rotates each rotated object about its centre. Culling bounds a rotated object by the circle through its corners                                                                                                                  |
| I-7  | **Production defect.** Every presigned PUT carried a CRC32 of an EMPTY body (an AWS SDK default), which real S3 rejects                                  | Checksums `WHEN_REQUIRED`. Found by making the fake S3 verify what S3 verifies; removing the fix fails 5 tests                                                                                                                                 |
| I-8  | **Defect.** Content type was never signed (only `content-length;host`), so a presigned URL accepted any content type                                     | `signableHeaders` includes `content-type`                                                                                                                                                                                                      |
| I-9  | The fake S3 checked no signatures (D13-3)                                                                                                                | It verifies SigV4 presigned requests: the signature, the expiry, every signed header, and the URL checksum against the body. Tests cover a wrong type, a wrong size, a tampered signature and a pushed-out expiry. Unsigned GET is public-read |
| I-10 | Uploaded images were never collected                                                                                                                     | `ImageCollector`: after a 7-day grace, an image that no op and no snapshot on any board mentions is deleted. It runs after the trash purge                                                                                                     |
| I-11 | Presence colours were round-robin per instance                                                                                                           | One Redis counter per board, with the room's own rotation as the fallback                                                                                                                                                                      |
| I-12 | The export clamp limited area only                                                                                                                       | It also caps the longest side at 16,384 px                                                                                                                                                                                                     |

Still open, and not fixable in code:

- The copy gaps need product copy.
- `braces` (through Tailwind 3) has no patched release.
- The trash restore "collapse" stays opacity-only, because the motion rules forbid animating height.

### Phase 14 — States, responsive, accessibility, polish (M5) · Whole team

**Detailed plan, written after a full survey of the code (supersedes the first-pass line).**

#### What exists

- Four of the five empty states.
- S-20.
- The 3-toast cap with "+N more".
- The modal focus trap and stack.
- The canvas `role="img"` summary.
- `prefers-reduced-motion` handling.
- No `transition: all`, `ease-in` or `scale(0)` anywhere; `tokens.test.ts` enforces this.
- 17 of the 22 edge cases already behave as specified: E-01–E-05, E-08, E-09, E-11–E-19 and E-22.

#### Defects found in the survey

| #     | Defect                                                                                                                                                                                   | Rule                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| P14-1 | **Canvas shortcuts fire while a modal is open.** `isTextEntryTarget` checks only inputs, so with focus on a modal's button, `R`, Delete or the arrow keys act on the board behind it     | FLOWS §13.3, R-A11Y-009 |
| P14-2 | **There is no error boundary at all.** One render error blanks the whole app, the header included. Nothing reports client errors                                                         | FLOWS §12.4, S-21       |
| P14-3 | **E-21: a slow board load spins forever.** There is no snapshot timeout                                                                                                                  | E-21                    |
| P14-4 | **Errors are announced politely and on a generic timer.** Toasts are always `aria-live="polite"` and 5 s; FLOWS §13.1 wants assertive errors and 3 / 6 / 8 s                             | FLOWS §13.1             |
| P14-5 | **A modal closes mid-delete.** Escape and the backdrop close it even while a destructive action is in flight. The body still scrolls behind it, and confirmations open focused on Cancel | FLOWS §13.2             |
| P14-6 | **E-07: presence does not drop to 10 Hz above 100 selected objects.** E-10: a resize mid-drag does not keep the view centred                                                             | E-07, E-10              |
| P14-7 | **Copy is inlined.** Toolbar, context menu, properties panels, dashboard chrome, zoom and undo controls, spinners and the toast's "Dismiss" are inline literals                          | R-UI-052                |

#### Slices

| PR  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                     | Tasks           | Proves                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| 14a | **Copy and empty states.** Every inlined string moves into `strings.ts` (P14-7), plus a lint guard that fails on new JSX prose in board and dashboard chrome. The board hint: "Pick a tool and start drawing" with an arrow to the toolbar, shown only while the board has never had an op (seq 0). Once anything is created it never returns, for anyone                                                                                 | 1, 2            | Component: every empty state renders the exact PRD §8.3 copy; the hint disappears for good                    |
| 14b | **Errors.** An app-wide `ErrorBoundary`, and a separate `CanvasErrorBoundary` so the header survives (S-21). An 8-character `Ref:` correlation id. `client_error` reports to `POST /api/client-errors` (validated, rate limited, logged). `window.onerror` and `unhandledrejection` are reported too. S-19 as an overlay on the frozen canvas. E-21: a 30 s snapshot timeout, then an inline retry. The generic server error shows `Ref:` | 3, 4, 5         | Component: both boundaries, the Ref shown; integration for the endpoint; e2e for E-21 with a delayed snapshot |
| 14c | **Toasts, modals and the keyboard.** Toasts: board bottom-left, 3 / 6 / 8 s, assertive errors (P14-4). Modals: scroll lock, an `initialFocus` prop, `dismissible={false}` while busy (P14-5). Shortcuts suppressed while any modal is open (P14-1). The S-15 `?` shortcuts modal from PRD Appendix A. Cmd/Ctrl+Enter submits forms. The board tab order                                                                                   | 7, 8, 9, 10, 11 | Component: toast aria-live, durations and the collapse; modal focus rules; shortcut suppression               |
| 14d | **Responsive.** `useBreakpoint`. At 1024–1279 the properties panel becomes a popover on selection. At 768–1023 the toolbar becomes a bottom bar. Below 768: 5 tools plus a `⋯` sheet, a bottom-sheet properties panel, a full-screen share sheet, no marquee, 44 px targets, and a single-column dashboard list. Tailwind `hoverOnlyWhenSupported` (R-MOTION-061)                                                                         | 12, 13          | e2e at 1440 / 1100 / 900 / 390 px: no horizontal scroll, and the right toolbar each time                      |
| 14e | **Accessibility.** axe on every route, at zero violations. A keyboard-only e2e pass. Avatar accessible names; E-20 truncates names at 20 characters with the full name on hover. The unsupported-browser screen. Reduced motion checked on every screen                                                                                                                                                                                   | 14, 15, 16      | e2e axe scan; keyboard pass                                                                                   |
| 14f | **Edge cases, motion and analytics.** E-07 and E-10 (P14-6). An explicit E-01–E-22 checklist with a test reference each. The `emil-design-eng` review table, with its fixes. All 14 PRD §9 events wired with their properties                                                                                                                                                                                                             | 6, 17, 18       | e2e or unit per edge case; analytics unit tests                                                               |

**Ownership heads-up (`R-ARCH-006`):** 14c and 14f touch `features/canvas/interaction` (shortcut suppression, E-07); 14b touches `features/sync` (E-21 timeout).

Exit gate:

- Every P0/P1 requirement has a passing test.
- All 22 edge cases are verified.
- Zero axe violations.
- Keyboard-only navigation works.
- Every breakpoint renders without horizontal scroll.
- The motion review is done and its findings fixed.
- Copy matches PRD §8.

#### Phase 14 outcome

All six slices landed, and P14-1 to P14-7 are fixed. Spec conflicts found on the way are in the defect register:

- **D-16:** mobile properties appear as a sheet, and only for a selection.
- **D-17:** the 768–1279 px popover also opens for a tool's settings, or pen colour would have no home at those widths.
- **D-18:** the frozen muted/subtle token pair is 4.39:1, under WCAG AA. The tokens stay; the failing pairings are gone.

Other findings:

| #    | Finding                                                                                                                                                    | Fix                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-13 | The responsive e2e caught the trash row collapsing at 390 px: the name was squeezed to zero width                                                          | Below 768 px the actions wrap onto their own line                                                                                                                             |
| I-14 | The `xform` presence message was in the protocol and relayed by the server, but the client never sent or drew it, so a remote drag appeared only on commit | Sent at 20 Hz (10 Hz above 100 selected, E-07). The sender's selection outline is drawn offset on the overlay layer, so layer 1 is never touched                              |
| I-15 | Internet Explorer cannot run the module bundle, so a React "unsupported" screen could never render there                                                   | A static `nomodule` screen in `index.html`, pinned to `errors.unsupportedBrowser` by a unit test. A feature check in `main.tsx` covers module-capable browsers missing an API |
| I-16 | `pnpm audit` reports one high advisory: `braces` through tailwindcss → chokidar. It predates this phase and has no patched version                         | Not fixable here. Recorded for Phase 15's dependency pass                                                                                                                     |

**Motion review (`emil-design-eng`, R-SKILL-072).**

| Before                                                                | After                                                                         | Why                                                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Share modal on mobile entered as a centred modal (`translate: 0 8px`) | `translate: 0 100%` → 0 on `--ease-drawer`, 320 ms, for `[data-sheet='true']` | A sheet attached to the bottom edge should rise from that edge. A percentage fits any content height          |
| `[data-presence-stale]` `filter 300ms`                                | `filter var(--duration-base)`                                                 | A state indication, not decoration: inside the 200 ms standard band                                           |
| Member-row flash at 400 ms (transition and keyframe)                  | `var(--duration-slow)` (320 ms)                                               | Feedback stays near the 300 ms ceiling. Each flash is a fresh row, so a keyframe restarting does no harm here |
| Button spinner crossfade `duration-200`                               | `duration-base`                                                               | Use the token, not an arbitrary value (R-UI token contract)                                                   |
| Join card at 400 ms                                                   | Kept                                                                          | The one "rare" band flourish, once per person per board (Phase 12 table)                                      |
| Dashboard card hover animates `box-shadow`                            | Kept, hover-gated (`hoverOnlyWhenSupported`)                                  | Tens a day, 150 ms, on an isolated card. A pseudo-element opacity trick is not worth the markup               |

Already compliant: no `transition: all`, no `ease-in`, no `scale(0)`. Popovers scale from their trigger; modals stay centred. Toolbar and tool switching have no animation. Reduced motion keeps opacity and colour and drops transforms (asserted in e2e).

**Edge cases E-01 to E-22.**

| ID   | Verified by                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| E-01 | `presence.spec.ts`, `presence.test.ts` (avatar dedupe)                                                      |
| E-02 | `ConnectionMachine.test.ts` (visibility → reconnect check)                                                  |
| E-03 | `SyncEngine.test.ts` "E-03: a wrong client clock cannot reorder"                                            |
| E-04 | `viewport.test.ts` (±1,000,000 clamp); server Zod bounds                                                    |
| E-05 | `images.spec.ts`, `uploadEngine.test.ts`, `uploads.integration.test.ts`                                     |
| E-06 | `phase5.test.ts` (plain-text paste)                                                                         |
| E-07 | `canvas-performance.spec.ts` (one op for 500), `presence.test.ts` "drag presence — FLOWS E-07" (20 / 10 Hz) |
| E-08 | `selection.test.ts`, `viewport.test.ts`                                                                     |
| E-09 | `canvas-draw.spec.ts`, `draw.test.ts`                                                                       |
| E-10 | `canvas-viewport.spec.ts` "a resize mid-drag keeps the centre and the drag"                                 |
| E-11 | `canvas-selection.spec.ts`, `hitTest.test.ts`, `transformSelection.test.ts`                                 |
| E-12 | `canvas-performance.spec.ts` (culling), `stroke.test.ts` (straight segments below 25%)                      |
| E-13 | `SyncEngine.test.ts` (snapshot after three unknown objects)                                                 |
| E-14 | `SyncEngine.test.ts` "is IDEMPOTENT" and "DROPS buffered ops the snapshot already contains"                 |
| E-15 | `SyncEngine.test.ts` "buffers a gap and drains contiguously" and "asks the server for the missing ops"      |
| E-16 | `dashboard.test.tsx`                                                                                        |
| E-17 | `SessionExpiredBanner.test.tsx`                                                                             |
| E-18 | `guestIdentity.test.ts` (in-memory fallback)                                                                |
| E-19 | `socket.integration.test.ts` "E-19: two simultaneous renames"                                               |
| E-20 | `presence.test.ts` (`truncateName`); the avatar tooltip carries the full name                               |
| E-21 | `states.spec.ts`                                                                                            |
| E-22 | `export.spec.ts`, `export.test.ts`, `ExportModal.test.tsx`                                                  |

**Analytics.** `track()` is typed against PRD §9: an event cannot be sent without its listed properties, and none of them is personal data. All 14 events fire:

- `account_created` and `logged_in` fire after a successful password sign-up or log-in. Google sign-ins send `method: 'google'`; the server adds `?created=1` to the callback for a new account.
- `board_created` comes from the header button (`from: dashboard`), the empty state (`empty_state`) and Duplicate (`template: duplicate`).
- `tool_selected` fires on click or shortcut, only when the tool actually changes.
- `object_created` fires once per local CREATE in `applyAndEmit`, never for undo, redo or remote ops.
- `socket_disconnected` and `socket_reconnected` carry the close reason, session duration, attempt count, downtime and outbox size.
- `op_rejected` carries the server's refusal code, over both the socket and REST.

Tests: `socketAnalytics.test.ts`, `opAnalytics.test.ts`, `authAnalytics.test.ts`, plus the Toolbar and keyboard suites. There is still no provider (D-5): the sink records in development only, and pointing it at a service is a Phase 15 configuration change.

**Exit gate.** Every item in the gate above is met. Evidence is the axe, keyboard, responsive and reduced-motion e2e specs, the E-01 to E-22 table, the motion table, and `noInlineCopy.test.ts` for copy.

### Phase 15 — Performance, e2e, deployment, monitoring (M5) · Whole team

Plan written before any code, after a survey of the branch at `3c36f6c`.

#### What exists

- **Budgets.** Bundle budgets are met and gated in CI: initial JS 125 KB of 250, board chunk 51 KB of 200.
- **Frame and input metrics.** The stress-board e2e reports frame time and input-to-pixel latency: about 60 fps panning and drawing at 10,000 objects, input p95 about 8 ms.
- **Acceptance scenarios.** All 28 PRD §11 scenarios (AT-01 … AT-44; the missing numbers are gaps in the PRD's own numbering) have tests, and the five must-write tests from TRD §13.2 exist.
- **Logging.** A pino logger exists. Client errors carry a correlation id; server requests do not.
- **Health.** There is a `/health` route, but no `/metrics`.
- **CI.** Gates 1–7 run. The Lighthouse job (gate 8) is a placeholder.

#### Gaps found in the survey, including leftovers from earlier phases

| #     | Gap                                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P15-1 | **S-01 landing page is missing.** It is **P1** in the PRD §6 screen table, and FLOWS §1.2 / §3.1 define its edges. `/` currently redirects to `/login`, and logout lands on `/login` too, where PRD FR-AUTH-007 says "returns to the landing page". This settles open decision **A**. |
| P15-2 | **"Demo mode" (S-10 from "Try it now") does not exist.** Scratch boards are dev-only.                                                                                                                                                                                                 |
| P15-3 | **Two PRD §7.1 budgets have no measurement:** board first paint (500 / 5,000 objects) and the local-input-to-remote-render p95.                                                                                                                                                       |
| P15-4 | **Lighthouse CI is a placeholder.** Landing LCP and dashboard-interactive are unmeasured.                                                                                                                                                                                             |
| P15-5 | **No memory soak test** (TRD §12.3: 30 minutes, close and reopen 10 times, growth near zero).                                                                                                                                                                                         |
| P15-6 | **No load test** (PRD §7.2: 50 concurrent users on a board, 100 ops/s sustained).                                                                                                                                                                                                     |
| P15-7 | **No observability.** No request correlation id from the edge to the logs. Op rejections are not logged with code, board, actor and correlation id. None of the eight TRD §15.4 signals is exported, and there are no alert rules.                                                    |
| P15-8 | **No deployment, backup or runbook.** No Dockerfiles or proxy config (sticky sessions, WebSocket upgrade), no deploy workflow, no backup or restore, no `docs/RUNBOOK.md`.                                                                                                            |
| P15-9 | **Phase 14 leftovers.** AT-08 and the thumbnail e2e fail under the full parallel run, though they pass alone. `pnpm audit` gate 6 is red on a `braces` advisory that has no patched release.                                                                                          |

#### Decisions taken (flagged per the ambiguity rule; reversible)

- **Landing copy.** PRD §8 fixes only the CTA labels ("Log in", "Sign up free", "Try it now"). The headline, sub-copy and feature lines are written to the product description in PRD §1 and kept in `strings.ts`. Each is a one-line change.
- **D-19.** FLOWS labels the demo edge both "Try it now" (§1.2 table) and "Try a demo board" (§1.1 map). The table wins: it is the authoritative edge list.
- **Demo mode** is `/demo`: the real board UI on a local-only document, with no account, no sync and nothing persisted. A bar offers "Sign up free". No server writes, so nothing needs authorizing.
- **`braces` advisory.** Build-time only: tailwindcss → chokidar watches files during development and nothing ships to the browser. With no fix to take, CI gets a narrowly scoped exception (`pnpm.auditConfig.ignoreGhsas` naming that one advisory id) recorded as defect **D-20**, rather than a disabled gate. It is to be removed when a patch ships.
- **What this container cannot do.** Push to Cloudflare, run Docker images (no daemon), or drive Safari and real devices. Those steps are written as config plus a runbook and marked **manual** in the outcome, not claimed as done.

#### Slices

| PR  | Scope                                                                                                                                                                                                                                                                                                                                                                                            | Covers             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| 15a | **S-01 landing and demo mode.** Marketing zone: `gpt-taste` design plan, `design-taste-frontend` Design Read 7/6/4, `high-end-visual-design` archetypes, no GSAP. The hero runs a live loop of two labelled cursors drawing, in CSS/SVG with no canvas engine in the landing chunk. Authed visitors redirect to S-07. Logout goes to S-01. `/demo` is a local board. Axe and e2e cover all of it | P15-1, P15-2, D-19 |
| 15b | **Measured budgets.** First-paint perf marks, asserted in e2e at 500 and 5,000 objects. A p95 local-input-to-remote-render measurement (two contexts, timestamps on each side) asserted in e2e. Lighthouse CI on landing and dashboard as a real gate 8                                                                                                                                          | P15-3, P15-4       |
| 15c | **Memory.** A Playwright soak over CDP: heap snapshot, use the board, close and reopen 10 times, force GC, compare. Five minutes in CI, 30 with `SOAK_MINUTES=30`. Any leak found gets fixed                                                                                                                                                                                                     | P15-5              |
| 15d | **Load.** `scripts/load-test.ts`: 50 `ws` clients on one board, 100 ops/s for 60 s. It reports ack p95, nacks and dropped ops, and checks the op log has every acked op exactly once                                                                                                                                                                                                             | P15-6              |
| 15e | **Observability.** A request id middleware (accept or mint `x-request-id`, echo it, put it in every log line), socket session ids in logs, op-rejection logs with code, board, actor and correlation id, a `/metrics` endpoint covering the eight TRD §15.4 signals, and Prometheus alert rules at the TRD thresholds                                                                            | P15-7              |
| 15f | **Deploy and recover.** Dockerfiles (server; web served by nginx), `infra/nginx.conf` with `ip_hash` and WebSocket upgrade, `infra/docker-compose.prod.yml`, `deploy.yml` (images built in CI; the deploy step is gated on secrets), `scripts/backup.sh` / `restore.sh` with a restore test run against a scratch database, and `docs/RUNBOOK.md`                                                | P15-8              |
| 15g | **Close-out.** Root-cause the AT-08 and thumbnail flakes, add the D-20 audit exception, automate what can be automated from the TRD §13.3 manual QA list, add Playwright Firefox/WebKit projects for CI, and update the status in docs                                                                                                                                                           | P15-9              |

**Ownership heads-up (`R-ARCH-006`):** 15b instruments `features/sync` and the renderer (perf marks only); 15c may touch any module a leak is found in.

Exit gate (plan §Phase 15): every budget measured and CI-enforced, every AT scenario passing, a tested backup restore, monitoring and alert rules for the eight signals. Deployment config is complete; the live deploy and real-device checks are listed as manual steps.

#### Phase 15 outcome

All seven slices landed, and P15-1 to P15-9 are closed. New defect-register entries: **D-19** (the demo CTA label), **D-20** (a scoped audit exception for an unpatchable build-time advisory) and **D-21** (which Lighthouse profile each budget uses).

**PRD §7.1 budgets, measured on the production build and gated in CI.**

| Budget                                | Measured                | Limit             | Where                                                     |
| ------------------------------------- | ----------------------- | ----------------- | --------------------------------------------------------- |
| Landing LCP, slow 4G + 4× CPU         | 731 ms (was 2,378)      | 1,500 ms          | `scripts/lighthouse.ts`                                   |
| Dashboard interactive, desktop        | 540 ms                  | 2,000 ms          | `scripts/lighthouse.ts` (slow 4G ≈ 2.4 s, advisory, D-21) |
| Board first paint, 500 objects        | 473 ms                  | 1,500 ms          | `budgets.spec.ts`                                         |
| Board first paint, 5,000 objects      | 651 ms                  | 3,000 ms          | `budgets.spec.ts`                                         |
| Drawing / panning, 10,000 objects     | ≈ 60 fps                | ≥ 55 fps          | `canvas-performance.spec.ts`                              |
| Input to local pixel, p95             | ≈ 8 ms                  | 16 ms             | `canvas-performance.spec.ts`                              |
| Local input to remote render, p95     | 61 ms                   | 250 ms            | `budgets.spec.ts`                                         |
| Initial JS / board chunk, gzipped     | 132.8 KB / 51.3 KB      | 250 / 200 KB      | `pnpm analyze`                                            |
| Heap after use; growth over 9 reopens | 30 MB; 0.83 MB          | 300 MB; near zero | `memory.spec.ts`                                          |
| Load: 50 users, 100 ops/s, 60 s       | ack p95 ≈ 20 ms, 0 lost | —                 | `pnpm load-test`                                          |

**Findings fixed on the way.**

| #    | Finding                                                                                                                                                                 | Fix                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-17 | **Landing LCP 2.4 s.** A client-rendered page paints nothing until ~130 KB of JS arrives                                                                                | S-01 is prerendered at build. CSS is inlined and the app JS loads after first paint, for `/` only. `index.html` serves `/` and `app.html` is the SPA shell             |
| I-18 | **Every cold load paid an extra round trip.** The silent refresh started in a guard effect, then called `/auth/me` for a user the refresh response already carried      | The refresh starts at boot and uses the user it returns. The dashboard chunk is fetched in parallel                                                                    |
| I-19 | **Load test: ack p95 587 ms.** Concurrent snapshots of one board piled up, and Prisma took ~650 ms to write 1.7 MB of Json                                              | One snapshot per board at a time, a seq hint, and a parameterized `INSERT … ::jsonb`. p95 is now ~20 ms                                                                |
| I-20 | **`redis()` attached an `error` listener per call**: one closure leaked per op                                                                                          | Attached once                                                                                                                                                          |
| I-21 | **`test.use({ reducedMotion })` silently does not apply with the preinstalled Chromium**, so the Phase 14 reduced-motion e2e passed without emulation                   | `page.emulateMedia`. Both specs pass for real                                                                                                                          |
| I-22 | **The server's `pnpm start` crashed on Node 20**: `@coboard/shared` resolves to `.ts` source                                                                            | A `coboard-dist` export condition, used by `start` and the image                                                                                                       |
| I-23 | **The full e2e suite exhausted the registration limit** (10 per IP per 15 min) and later specs failed with 429. This was behind most "flakes under load" since Phase 13 | `REGISTER_RATE_LIMIT`: default 10, raised only for the e2e servers, refused above 10 in production. Perf specs run in their own project, after the rest, on one worker |
| I-24 | **The thumbnail e2e mixed two paths.** Leaving by URL races the new dashboard's fetch against the `pagehide` upload                                                     | Two tests: in-app navigation (live update) and leaving by URL (the upload lands)                                                                                       |
| I-25 | **The old AT-12 test was an approximation**: sockets dropped, but the server never died                                                                                 | `restart.spec.ts` owns its own API process, SIGKILLs it mid-session, and keeps drawing. All strokes survive exactly once                                               |

**TRD §13.3 manual QA, automated where possible.**

| #   | Item                                  | Automated by                                                                        |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Two windows, compare hashes           | `convergence.spec.ts`, `realtime.spec.ts` (AT-02, AT-08)                            |
| 2   | Offline, 10 strokes, back online      | `convergence.spec.ts` AT-30                                                         |
| 3   | Slow 3G, local drawing instant        | `convergence.spec.ts` AT-32                                                         |
| 4   | 10k stress board while panning        | `canvas-performance.spec.ts`                                                        |
| 5   | Hit testing at 10% and 500%           | `canvas-selection.spec.ts` E-11, `hitTest.test.ts`                                  |
| 6   | Keyboard-only pass                    | `keyboard.spec.ts`, `dashboard.spec.ts`, axe on every route                         |
| 7   | Every breakpoint                      | `responsive.spec.ts`                                                                |
| 8   | Safari / Firefox / Chrome strokes     | `cross-browser.spec.ts` (CI job `cross-browser`; advisory until it has run history) |
| 9   | Kill and restart the server           | `restart.spec.ts`                                                                   |
| 10  | Trash a board with three people on it | `sharing.spec.ts` AT-23                                                             |

**Still manual: this container cannot do these.**

- A live deploy behind Cloudflare: `deploy.yml` is ready and skips without secrets. The steps are in RUNBOOK §11.
- The first real `docker build`.
- Real-device checks, including the mid-range Android motion check.
- A visual Safari pass: WebKit runs in CI, but it is not Safari on a Mac.
- Alert routing (Alertmanager or Grafana).
- The first quarterly human restore drill: the scripted drill is automated daily.
- ~~Vitest's moderate advisory GHSA-82fw-gwwq-j7x9 needs a major upgrade to v4.~~ Done in the §7 audit (vitest 4.1.11).

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

| #   | Question                                                                                                                                                                                                                              | Blocks   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A   | **S-01 landing page** has no task in any phase list (only the `App.tsx:67` comment says "Phase 15"). Confirm it is in scope and which phase owns it. **Resolved:** P1 in PRD §6, built in Phase 15a.                                  | Phase 15 |
| B   | **Image upload**: code comments say Phase 12, plan tasks say Phase 13. Confirm Phase 13. **Resolved:** Phase 13 (13b/13c).                                                                                                            | 13b/13c  |
| C   | **`Q-2` object cap** is due at Phase 11. Proceed on the interim position (soft 10k, hard 50k)? **Resolved:** soft 10k warning, hard 50k cap enforced in `OpService`.                                                                  | 11d      |
| D   | **`Q-1` guest persistence** was due at Phase 10 and is still unratified. Proceed on the interim (rows kept, swept after 24 h idle)? **Resolved:** guest rows kept, swept by the `guest_sweep` maintenance job after 24 h idle.        | 12b, 12f |
| E   | **S3 in dev**: `docker-compose.yml` has Postgres + Redis only. Add MinIO for local uploads? **Resolved:** no MinIO; the in-process fake S3 (`dev/fakeS3.ts`) starts with `pnpm dev`.                                                  | 13b      |
| F   | `Q-3`/`Q-4`/`Q-5` — due Phase 14; interim positions (chrome-only dark mode, fixed 30 days, Inter everywhere) apply unless overruled. **Resolved:** Q-3 dark mode is FR-SET-002 (P2, not built); 30-day fixed trash; Inter everywhere. | Phase 14 |

## 7. Post-Phase-15 audit

A full sweep after Phase 15: an independent review of the server, the web client and the infra/docs against the four specifications and `RULES.md`, then a requirement-by-requirement pass over PRD §6–§8 and every FLOWS screen. Everything it found is fixed below, or listed under "Still open" with the reason.

**Security (server).** UPDATE payloads are validated strictly against the target object's type inside the append transaction, and CREATE needs `payload.id === objectId` (256 KB cap per payload, not 64 KB: a long full-precision stroke legitimately exceeds 64 KB). Invites are claimed only for a proven address: a verification link, `POST /api/auth/verify-email`, Google `email_verified`, and pre-hijack password clearing (D-22). A guest who converts keeps their role (D-23). Also: a join failure closes the socket with 1011 instead of crashing the process; rate limits on REST ops, ticket minting and presence; unjoined sockets closed after 10 s; only an `AuthError` nacks FORBIDDEN; op-id collisions nacked; SVGs served as attachments; image URLs must be our own uploads; a login success no longer clears per-IP failures; forgot-password timing equalised; reset races return 400; permanent delete notifies the room; client-error URLs scrubbed; production refuses to boot without `SMTP_URL`, which now sends real mail through nodemailer.

**Correctness (web).** A viewer promoted mid-session starts persisting. No duplicate sockets from a racing ticket fetch. Nothing lands after a session is disposed. Transforms write and send geometry keys only, so undo never reverts a teammate's colour or text. z-order ties break on `(zIndex, id)` everywhere. Demotion and Escape cancel any live gesture. Every board load starts from an empty store, and uploads belong to their board. The presence sweep is scheduled, the image cache never evicts the current frame, and text edits debounce their op.

**Requirement gaps closed.**

- Routes, auth, dashboard: S-20 404, `/dashboard/trash` (D-30), guests exit to S-01 (D-31), S-11 "Log in instead" (D-37), the reset-reason banner, global `?` shortcuts (D-33), signup 409 link and 429 countdown, the welcome toast (D-39), card avatars (D-38), the full card menu (D-35), Trash auto-return, avatar upload (D-36), and the copy fixes (D-32).
- Board and canvas: S-13 board settings (D-24), sticky drag-to-size, "Change colour" (D-25), remote selection name labels, over-capacity joins admitted as viewers (D-26), the board-too-large warning, the rest of the properties panel, one load shell with "Loading N objects…", and the text editor kept above the mobile keyboard.
- Copy and behaviour conflicts recorded as D-27, D-28 and D-29.

**Infra and dependencies.** The deploy reloads nginx after each server swap, validates its tag and ships the backup scripts. CI permissions are tightened, and e2e runs both stages through `scripts/e2e.sh`. Lighthouse runs as a pinned CLI on Node 22 because Lighthouse 13 broke Node 20 installs. The metrics label `job` is renamed to `task`, because it collided with Prometheus's own `job` label. `proxy-addr` and `source-map-js` are overridden to patched releases, and vitest is upgraded to 4.1.11 (clearing the critical tinypool advisories). `pnpm audit --audit-level high` exits 0, and `pnpm install` works on Node 20.

**Verified on the final tree.** Typecheck, lint (zero warnings) and format are clean; 1,380 unit and integration tests pass; e2e passes in both stages (173 + 22, perf with one worker); `pnpm analyze` reports 138 KB initial JS / 250 KB and a 53 KB board chunk / 200 KB; Lighthouse gives landing LCP 919 ms / 1,500 ms on slow 4G and dashboard interactive 560 ms / 2,000 ms on desktop (slow-4G advisory 2,507 ms, D-21). The final e2e run also caught one regression introduced during the audit: leaving a board cleared the store before the thumbnail cleanup read it, which sent `DELETE /thumbnail`. It is fixed, with a unit test.

**Still open, by decision.**

- "Replace image" (FLOWS §14.4 only; not in FR-CANVAS-010) is not built.
- An over-capacity viewer's REST op path is gated by their real role, not the room: capacity is a load limit, not authorization.
- A long-lived socket's role is re-checked per op batch and on live invalidation, never on a timer.
- Selection-panel sliders add one undo entry per change event, not one per drag.
- Deploy notes: the upload bucket's CORS must allow `content-disposition`, and `CSP_IMG_ORIGINS` must include `https://lh3.googleusercontent.com` when Google sign-in is on (both in `docs/RUNBOOK.md`).
