import { expect, test } from '@playwright/test'
import { driveRandomOperations } from './support/driveRandomOperations.js'
import {
  diagnose,
  drawStroke,
  dropSocket,
  expectSettled,
  goOffline,
  goOnline,
  objectCount,
  reading,
  register,
  twoWindows,
} from './support/realtime.js'

/**
 * Convergence and chaos — Phase 11, M4 "It survives".
 *
 * TRD §6.5 / PRD risk R-1: two contexts, seeded random operations, and a full
 * state-hash comparison at the end. Then the network is taken away in every
 * way the chaos scenarios AT-30 … AT-35 describe, and the same comparison has
 * to hold. Seeds are printed in the test titles so a failure replays exactly.
 */

test.describe.configure({ mode: 'serial' })
// Two browsers, a real server and hundreds of round trips per test.
test.setTimeout(120_000)

let email: string | null = null
test.beforeEach(async ({ page }) => {
  email ??= await register(page)
})

for (const seed of [11, 4242]) {
  test(`convergence: 200 random concurrent operations each, seed ${seed}`, async ({
    browser,
  }) => {
    const { a, b, boardId, contextA, contextB } = await twoWindows(browser, email!)

    await driveRandomOperations(a, b, { seed, steps: 200 })

    const final = await expectSettled(a, b, 30_000).catch(async error => {
      console.log(`[convergence] seed ${seed} FAILED\n${await diagnose(a, b, boardId)}`)
      throw error
    })
    console.log(
      `[convergence] seed ${seed}: seq ${final.seq}, ${final.objects} objects, hash ${final.hash}`,
    )
    expect(final.seq).toBeGreaterThan(100)

    await contextA.close()
    await contextB.close()
  })
}

/* ── Chaos — AT-30 … AT-35, AT-12 ────────────────────────────────────────── */

test('AT-30: offline, draw 10 strokes, come back — all 10 everywhere, none twice', async ({
  browser,
}) => {
  const { a, b, contextA, contextB } = await twoWindows(browser, email!)

  await goOffline(contextA, a)
  for (let i = 0; i < 10; i++)
    await drawStroke(a, 120 + (i % 5) * 90, 160 + Math.floor(i / 5) * 140)
  expect(await objectCount(a)).toBe(10)
  // B sees nothing yet: the work is queued, not lost.
  expect(await objectCount(b)).toBe(0)
  expect((await reading(a))!.pending).toBe(10)

  await goOnline(contextA)
  const final = await expectSettled(a, b)
  expect(final.objects).toBe(10)

  await contextA.close()
  await contextB.close()
})

test('AT-31: both offline, both draw, both return — everything merges', async ({
  browser,
}) => {
  const { a, b, contextA, contextB } = await twoWindows(browser, email!)

  await goOffline(contextA, a)
  await goOffline(contextB, b)
  for (let i = 0; i < 5; i++) {
    await drawStroke(a, 120 + i * 90, 160)
    await drawStroke(b, 120 + i * 90, 360)
  }
  await goOnline(contextA)
  await goOnline(contextB)

  const final = await expectSettled(a, b)
  expect(final.objects).toBe(10)

  await contextA.close()
  await contextB.close()
})

test('offline merge: A draws 10 offline while B draws 10 online — 20 on both', async ({
  browser,
}) => {
  const { a, b, contextA, contextB } = await twoWindows(browser, email!)

  await goOffline(contextA, a)
  for (let i = 0; i < 10; i++) {
    await drawStroke(a, 100 + (i % 5) * 90, 140 + Math.floor(i / 5) * 120)
    // B's rows start right of x=300: A's offline/online gives B a "left" and a
    // "joined" toast, and stacked bottom-left they cover the canvas there.
    await drawStroke(b, 320 + (i % 5) * 90, 400 + Math.floor(i / 5) * 100)
  }
  await goOnline(contextA)

  const final = await expectSettled(a, b)
  expect(final.objects).toBe(20)

  await contextA.close()
  await contextB.close()
})

test('AT-32: 3G with 400 ms latency — local drawing stays instant, sync catches up', async ({
  browser,
}) => {
  const { a, b, contextA, contextB } = await twoWindows(browser, email!)
  const cdp = await contextA.newCDPSession(a)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: (750 * 1024) / 8,
    uploadThroughput: (250 * 1024) / 8,
  })

  for (let i = 0; i < 5; i++) {
    const before = await objectCount(a)
    await drawStroke(a, 150 + i * 90, 250)
    // On screen at once — the network is not on the drawing path.
    expect(await objectCount(a)).toBe(before + 1)
  }

  await expectSettled(a, b, 45_000)
  await contextA.close()
  await contextB.close()
})

test('AT-33: the connection dies mid-stroke — the stroke commits whole, never half', async ({
  browser,
}) => {
  const { a, b, contextA, contextB } = await twoWindows(browser, email!)

  await a.getByTestId('tool-pen').click()
  await a.mouse.move(200, 200)
  await a.mouse.down()
  for (let i = 1; i <= 10; i++) await a.mouse.move(200 + i * 12, 200 + i * 7)
  await dropSocket(a)
  for (let i = 11; i <= 20; i++) await a.mouse.move(200 + i * 12, 200 + i * 7)
  await a.mouse.up()

  await expectSettled(a, b)
  const points = (p: typeof a) =>
    p.evaluate(() =>
      (window as unknown as { __coboardObjects: () => Array<{ points?: number[] }> })
        .__coboardObjects()
        .map(o => o.points?.length ?? 0),
    )
  const [pa, pb] = await Promise.all([points(a), points(b)])
  expect(pa).toHaveLength(1)
  expect(pb).toEqual(pa)

  await contextA.close()
  await contextB.close()
})

test('AT-34: 30 rapid disconnect cycles — no duplicates, no zombie sockets', async ({
  browser,
}) => {
  const { a, b, contextA, contextB } = await twoWindows(browser, email!)
  const open = { a: 0, b: 0 }
  a.on('websocket', ws => {
    if (!ws.url().includes('/ws?')) return
    open.a++
    ws.on('close', () => open.a--)
  })
  b.on('websocket', ws => {
    if (!ws.url().includes('/ws?')) return
    open.b++
    ws.on('close', () => open.b--)
  })

  await driveRandomOperations(a, b, {
    seed: 34,
    steps: 60,
    between: async step => {
      if (step % 2 === 0) await dropSocket(step % 4 === 0 ? a : b)
    },
  })

  await expectSettled(a, b, 60_000)
  // Exactly one live socket each: every cycle's socket was closed, not leaked.
  expect(open).toEqual({ a: 1, b: 1 })

  await contextA.close()
  await contextB.close()
})

test('AT-35: a forged malformed op from the console is refused and harms no one', async ({
  browser,
}) => {
  const { a, b, contextA, contextB } = await twoWindows(browser, email!)

  await a.evaluate(() => {
    const net = (window as unknown as { __coboardNet: { send(raw: string): boolean } })
      .__coboardNet
    net.send('not json at all')
    net.send(JSON.stringify({ t: 'op', op: { id: 'x', type: 'CREATE' } }))
    // 1e999 parses to Infinity: the coordinate that blanks every canvas in the
    // room if the server ever accepts it (R-SEC-004).
    net.send(
      '{"t":"op","op":{"id":"00000000-0000-4000-8000-0000000000ff","type":"CREATE","objectId":"00000000-0000-4000-8000-0000000000fe","payload":{"x":1e999}}}',
    )
  })

  // Nothing landed, and both clients still work.
  await drawStroke(a, 200, 200)
  await drawStroke(b, 300, 300)
  const final = await expectSettled(a, b)
  expect(final.objects).toBe(2)

  // And the server is still up — a malformed frame must not crash it.
  const health = await a.request.get('http://localhost:3000/health')
  expect(health.ok()).toBe(true)

  await contextA.close()
  await contextB.close()
})

test('AT-12 (approximation): every socket drops at once mid-session — nothing lost', async ({
  browser,
}) => {
  /*
   * The real kill-and-restart is tests/e2e/restart.spec.ts (Phase 15g), which
   * owns its own server process. This one stays because it covers TWO
   * clients and a random operation mix through the outage. What a restart does to CLIENTS is
   * reproduced exactly: every socket dies with no close frame while ops are
   * in flight, and every client must reconnect, rejoin with sinceSeq, replay
   * its outbox and converge. Server-side durability across a restart rests on
   * persist-before-ack (R-SYNC-012), covered by the socket integration suite.
   */
  const { a, b, contextA, contextB } = await twoWindows(browser, email!)

  await driveRandomOperations(a, b, {
    seed: 12,
    steps: 40,
    between: async step => {
      if (step === 20) await Promise.all([dropSocket(a), dropSocket(b)])
    },
  })

  await expectSettled(a, b, 60_000)
  await contextA.close()
  await contextB.close()
})
