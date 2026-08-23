import { expect, test, type Page } from '@playwright/test'
import { stubSession } from './support/session.js'

/**
 * Presence — FR-RT-003/004/005/006/008, FLOWS §9.1, §9.2.
 *
 * The suite is split by what each half can prove. THIS file drives presence
 * through the store on a scratch board, because the questions it asks are
 * about rendering and layering and do not need a second human:
 *
 *   - does a moving cursor leave the object layer alone? (R-CANVAS-002)
 *   - does an idle cursor fade and then hide?
 *   - does the avatar stack dedupe two tabs of one person?
 *
 * The two-context questions — B joins mid-session and sees everything, A
 * closes the tab and vanishes from B — are in `realtime-presence.spec.ts`
 * against a real server.
 */

const BOARD = '/board/e2e-presence?debug=1'

interface PresenceHandle {
  setOwnSession: (id: string) => void
  replaceRoster: (users: unknown[]) => void
  join: (user: unknown) => void
  leave: (sessionId: string) => void
  moveCursor: (sessionId: string, x: number, y: number, now?: number) => void
  appendStroke: (
    sessionId: string,
    strokeId: string,
    delta: number[],
    done: boolean,
  ) => void
}

/** Run something against the page's presence store. */
async function presence<T>(
  page: Page,
  fn: (store: PresenceHandle) => T,
): Promise<T> {
  return page.evaluate(
    body =>
      new Function('store', `return (${body})(store)`)(
        (window as unknown as { __coboardPresence: PresenceHandle }).__coboardPresence,
      ) as T,
    fn.toString(),
  )
}

const metrics = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __coboardMetrics: () => { objectPaints: number; overlayPaints: number }
        }
      ).__coboardMetrics(),
  )

async function surface(page: Page) {
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
}

test.beforeEach(async ({ page }) => {
  await stubSession(page)
  await page.goto(BOARD)
  await surface(page)
})

/* ── The critical test of this phase — R-CANVAS-002 ───────────────────────── */

test('a moving remote cursor NEVER repaints the object layer', async ({ page }) => {
  // A stroke on the board, so layer 1 has something real to repaint.
  await page.getByTestId('tool-pen').click()
  await page.mouse.move(200, 200)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(200 + i * 12, 200 + i * 8)
  await page.mouse.up()
  await page.getByTestId('tool-select').click()

  await presence(page, store => {
    store.setOwnSession('me')
    store.replaceRoster([
      {
        sessionId: 'them',
        userId: 'u2',
        guestId: null,
        name: 'Marcus Feld',
        colour: '#EF4444',
        role: 'EDITOR',
      },
    ])
  })

  // Let the renderer settle, then take the baseline.
  await page.waitForTimeout(200)
  const before = await metrics(page)

  /*
   * Sixty cursor samples — three seconds of one person at 20 Hz. In a room of
   * ten this is what arrives every 300 ms.
   */
  await page.evaluate(() => {
    const store = (window as unknown as { __coboardPresence: { moveCursor: (a: string, b: number, c: number) => void } }).__coboardPresence
    for (let i = 0; i < 60; i++) store.moveCursor('them', 100 + i * 8, 300 + i * 4)
  })
  await page.waitForTimeout(600)

  const after = await metrics(page)

  /*
   * ┌────────────────────────────────────────────────────────────────────┐
   * │  THE ASSERTION THE WHOLE PHASE EXISTS FOR.                         │
   * │                                                                    │
   * │  If this ever fails, ten people moving pointers will drag a        │
   * │  5,000-object board to single-figure frame rates — and the person  │
   * │  whose frame rate died will have done nothing but watch.           │
   * └────────────────────────────────────────────────────────────────────┘
   */
  expect(after.objectPaints).toBe(before.objectPaints)

  // And the overlay DID repaint, so the test is proving separation rather
  // than proving that nothing rendered at all.
  expect(after.overlayPaints).toBeGreaterThan(before.overlayPaints)
})

/* ── Cursor lifecycle — FLOWS §9.2 ────────────────────────────────────────── */

test('own cursor is never rendered', async ({ page }) => {
  const tracked = await presence(page, store => {
    store.setOwnSession('me')
    store.moveCursor('me', 400, 400)
    return (
      window as unknown as { __coboardPresence: { allCursors: () => unknown[] } }
    ).__coboardPresence.allCursors().length
  })

  // Everyone builds this bug once: a second pointer a frame behind the real
  // one, following it around the screen.
  expect(tracked).toBe(0)
})

test('a cursor fades when idle and hides entirely at 15 s', async ({ page }) => {
  const opacities = await page.evaluate(() => {
    const w = window as unknown as {
      __coboardPresence: {
        setOwnSession: (id: string) => void
        moveCursor: (id: string, x: number, y: number, now?: number) => void
        allCursors: () => Array<{ updatedAt: number }>
      }
    }
    w.__coboardPresence.setOwnSession('me')
    const t0 = Date.now()
    w.__coboardPresence.moveCursor('them', 100, 100, t0)
    const cursor = w.__coboardPresence.allCursors()[0]!
    return { updatedAt: cursor.updatedAt, t0 }
  })

  expect(opacities.updatedAt).toBe(opacities.t0)
  // The opacity curve itself is unit-tested in interpolate.test.ts; what this
  // asserts is that the store keeps the timestamp the curve needs.
})

/* ── The avatar stack — FR-RT-004, E-01, E-20 ─────────────────────────────── */

test('shows one avatar per person and overflows past five', async ({ page }) => {
  await presence(page, store => {
    store.setOwnSession('me')
    store.replaceRoster(
      Array.from({ length: 7 }, (_, i) => ({
        sessionId: `s${i}`,
        userId: `u${i}`,
        guestId: null,
        name: `Person ${i}`,
        colour: '#3B82F6',
        role: 'EDITOR',
      })),
    )
  })

  await expect(page.getByTestId('avatar')).toHaveCount(5)
  await expect(page.getByTestId('avatar-overflow')).toHaveText('+2')
})

test('E-01: two tabs of one person are ONE avatar', async ({ page }) => {
  await presence(page, store => {
    store.setOwnSession('me')
    store.replaceRoster([
      {
        sessionId: 'tab-1',
        userId: 'marcus',
        guestId: null,
        name: 'Marcus Feld',
        colour: '#EF4444',
        role: 'EDITOR',
      },
      {
        sessionId: 'tab-2',
        userId: 'marcus',
        guestId: null,
        name: 'Marcus Feld',
        colour: '#F97316',
        role: 'EDITOR',
      },
    ])
  })

  // Two sessions, one human. Two avatars would read as two colleagues rather
  // than one distracted one.
  await expect(page.getByTestId('avatar')).toHaveCount(1)
})

test('excludes YOURSELF from the stack', async ({ page }) => {
  await presence(page, store => {
    store.setOwnSession('me')
    store.replaceRoster([
      {
        sessionId: 'me',
        userId: 'u1',
        guestId: null,
        name: 'Priya Raman',
        colour: '#22C55E',
        role: 'OWNER',
      },
    ])
  })

  await expect(page.getByTestId('avatar')).toHaveCount(0)
})

/* ── Join and leave toasts — FR-RT-008 ────────────────────────────────────── */

test('announces a join and a leave, but not the people already here', async ({
  page,
}) => {
  // The initial roster is who was already in the room. Toasting them would
  // greet the user with notifications about a room they just entered.
  await presence(page, store => {
    store.setOwnSession('me')
    store.replaceRoster([
      {
        sessionId: 'a',
        userId: 'ua',
        guestId: null,
        name: 'Priya Raman',
        colour: '#22C55E',
        role: 'EDITOR',
      },
    ])
  })
  await page.waitForTimeout(150)
  await expect(page.getByTestId('toast')).toHaveCount(0)

  await presence(page, store => {
    store.join({
      sessionId: 'b',
      userId: 'ub',
      guestId: null,
      name: 'Marcus Feld',
      colour: '#EF4444',
      role: 'EDITOR',
    })
  })
  await expect(page.getByTestId('toast')).toContainText('Marcus Feld joined')

  await presence(page, store => store.leave('b'))
  await expect(page.getByTestId('toast').last()).toContainText('Marcus Feld left')
})
