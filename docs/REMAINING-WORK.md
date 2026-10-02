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
| M4 — It survives   | 11     | 🟡 Partly started — groundwork exists, phase not delivered   |
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

| PR  | Scope                                                                                                                                                                                                           | Plan tasks       | Proves                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------- |
| 11a | `stateHash.ts` (sorted by id, floats to 2 dp) + `DebugPanel` behind `?debug=1` with `lastAppliedSeq`, `objects.size`, hash. **First, because every later slice is debugged with it**                            | T14, T15         | Unit: hash stable across order and float noise |
| 11b | `ConnectionMachine.ts` with guarded transitions; extract shared `backoff.ts` (8-attempt cap, 30 s ceiling); `visibilitychange` + manual retry triggers (`E-02`)                                                 | T1, T4, T5, T13  | Unit: backoff in `[0, min(2ⁿ·1000, 30000)]`    |
| 11c | Outbox hardening: inflight → front of queue on reconnect, never-retry-a-nack test, `E-18` in-memory fallback with no error shown, restore on load                                                               | T2, T3, T11, T12 | Unit: requeue order, nack drop, reload restore |
| 11d | `SYNCING`: rejoin with `sinceSeq`, apply missed ops, flush outbox FIFO with original ids; rejected-during-sync drops silently and removes undo entry; debounced 500 ms gap fill via `GET /operations?sinceSeq=` | T6, T7, T8       | `AT-12`, `AT-30`, `AT-33`                      |
| 11e | `ConnectionIndicator` with all five visible states + pending count; `OfflineBanner` at 500 ops / 10 min; presence desaturation while reconnecting                                                               | T9, T10, T17     | Component tests; `FR-RT-009`                   |
| 11f | Playwright convergence harness (`driveRandomOperations.ts`, 200 seeded ops, two contexts) + chaos specs `AT-31`, `AT-32`, `AT-34`, `AT-35`, offline-merge                                                       | T16              | **Exit gate:** 10 consecutive green runs       |

Exit gate: `AT-12`, `AT-30`–`AT-35` pass; debug panel shows matching hashes on two clients.

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
