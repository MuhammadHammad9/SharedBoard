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

### Phase 12 — Sharing, guest flow, permission enforcement (M5)

| PR  | Scope                                                                                                                                                             | Plan tasks |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 12a | `ShareLink` (+ `Star`) models and migration; `PermissionService.getRole` 60 s Redis cache + invalidation; `assertCanEdit` on every op, mutation endpoint, presign | T1–T3      |
| 12b | Share link create/get/revoke (CSPRNG); public `GET /share/:token`; `POST /share/:token/join`; `GET /boards/:id/access` full branch table                          | T4–T7      |
| 12c | `requireBoardAccess` six branches; S-11 `GuestEntry` with six failure branches, 40-char counter, `replace: true`; returning-guest "Not you?" chip                 | T8–T11     |
| 12d | Guest bar (7-day dismissal); guest → account conversion via new tab + `postMessage`                                                                               | T12, T13   |
| 12e | S-12 share modal: chips, member list, role/access dropdowns, copy with fallback, reset link; invite by email                                                      | T14, T15   |
| 12f | Role change/removal events, ejection handling (five events), S-17/S-18 (no board name on S-17 — `R-SEC-018`), viewer mode, room capacity, analytics               | T16–T21    |

Exit gate: guest joins in < 10 s; `AT-20`–`AT-24` pass. Rewrite the `realtime.spec.ts:392` workaround to use a real share link.

### Phase 13 — Export, images, thumbnails, trash, duplicate (M5)

| PR  | Scope                                                                                                                                                              | Plan tasks |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 13a | S-14 export modal + live preview; offscreen export with 8192² clamp; chunked rAF rendering > 2,000 objects; download + slugified filename; `E-22`                  | T1–T6      |
| 13b | Server: `POST /uploads/presign` and `/uploads/confirm` (magic bytes, SVG sanitization), `lib/s3.ts`                                                                | T7, T8     |
| 13c | Client upload (drag-drop, paste, toolbar), progress-ring placeholder, retry; `ImageObject` + LRU-100 cache; delete the placeholder rectangle                       | T9–T11     |
| 13d | Thumbnails on session end + every 5 min, `PUT /boards/:id/thumbnail`; empty-board graphic; Trash days-remaining + typed-name delete; Duplicate; `export_completed` | T12–T16    |

Exit gate: every P0/P1 feature exists.

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
