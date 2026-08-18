/**
 * Database seed — CLAUDE.md §5, PRD risk R-2.
 *
 * Produces a workspace you can actually judge the dashboard against:
 * three people, eight boards with realistic names and a plausible spread of
 * activity dates, one board in Trash, and the 10,000-object stress board.
 *
 * The names are real-looking on purpose (R-UI-060, the "Jane Doe effect").
 * A dashboard seeded with "Test Board 1" through "Test Board 8" looks fine at
 * every width and hides the truncation, wrapping and alignment problems that
 * "Q3 Retrospective — Platform & Infra" finds immediately.
 *
 * Idempotent: re-running upserts the people and replaces their boards, so
 * `pnpm db:seed` twice is the same as once.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import bcrypt from 'bcryptjs'
import { PrismaClient, type Prisma } from '@prisma/client'
import { BoardObjectSchema } from '@coboard/shared'

const prisma = new PrismaClient()

const FIXTURE = resolve(import.meta.dirname, '../../../fixtures/stress-board.json')

/** Everyone gets the same password. This database never leaves a laptop. */
const PASSWORD = 'coboard-dev-1'

const PEOPLE = [
  { email: 'priya@coboard.dev', displayName: 'Priya Raman' },
  { email: 'marcus@coboard.dev', displayName: 'Marcus Feld' },
  { email: 'yuki@coboard.dev', displayName: 'Yuki Tanaka' },
] as const

const DAY = 86_400_000

/** name, owner index, editors, days since last activity, trashed */
const BOARDS: Array<{
  name: string
  owner: number
  editors: number[]
  viewers?: number[]
  agedDays: number
  trashedDaysAgo?: number
}> = [
  { name: 'Q3 Retrospective — Platform', owner: 0, editors: [1, 2], agedDays: 0 },
  { name: 'Onboarding flow rewrite', owner: 0, editors: [1], agedDays: 1 },
  { name: 'Pricing page — v3 exploration', owner: 1, editors: [0], agedDays: 2 },
  { name: 'Incident 2026-07-14 timeline', owner: 1, editors: [], viewers: [0, 2], agedDays: 6 },
  { name: 'Hiring loop: staff frontend', owner: 2, editors: [0], agedDays: 11 },
  { name: 'Mobile gestures — open questions', owner: 0, editors: [2], agedDays: 24 },
  { name: 'Architecture: presence fan-out', owner: 2, editors: [0, 1], agedDays: 40 },
  { name: 'Offsite agenda (old)', owner: 0, editors: [], agedDays: 61, trashedDaysAgo: 4 },
]

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10)

  const users = []
  for (const person of PEOPLE) {
    users.push(
      await prisma.user.upsert({
        where: { emailLower: person.email.toLowerCase() },
        update: { displayName: person.displayName },
        create: {
          email: person.email,
          emailLower: person.email.toLowerCase(),
          displayName: person.displayName,
          passwordHash,
          emailVerified: true,
        },
      }),
    )
  }

  // Cascade takes memberships, ops and snapshots with the boards.
  await prisma.board.deleteMany({ where: { ownerId: { in: users.map(u => u.id) } } })

  const now = Date.now()

  for (const spec of BOARDS) {
    const owner = users[spec.owner]!
    const objects = sampleObjects(spec.name)

    await prisma.board.create({
      data: {
        name: spec.name,
        ownerId: owner.id,
        objectCount: objects.length,
        currentSeq: objects.length,
        lastActivityAt: new Date(now - spec.agedDays * DAY),
        createdAt: new Date(now - (spec.agedDays + 30) * DAY),
        deletedAt:
          spec.trashedDaysAgo !== undefined
            ? new Date(now - spec.trashedDaysAgo * DAY)
            : null,
        members: {
          create: [
            { userId: owner.id, role: 'OWNER' as const },
            ...spec.editors.map(i => ({ userId: users[i]!.id, role: 'EDITOR' as const })),
            ...(spec.viewers ?? []).map(i => ({
              userId: users[i]!.id,
              role: 'VIEWER' as const,
            })),
          ],
        },
        operations: {
          create: objects.map((object, i) => ({
            id: randomUUID(),
            seq: i + 1,
            type: 'CREATE' as const,
            objectId: object.id,
            payload: object as unknown as Prisma.InputJsonValue,
            actorId: owner.id,
          })),
        },
      },
    })
  }

  await seedStressBoard(users[0]!.id)

  console.log(`[seed] ${PEOPLE.length} users, ${BOARDS.length} boards + stress board`)
  console.log(`[seed] sign in as ${PEOPLE[0].email} / ${PASSWORD}`)
}

/**
 * The stress board — 10,000 objects, from the committed fixture.
 *
 * Inserted with `createMany` in chunks rather than one nested create: a single
 * statement carrying 10,000 rows exceeds Postgres's parameter limit, and the
 * failure mode is a bind error thousands of rows in rather than anything
 * legible.
 */
async function seedStressBoard(ownerId: string) {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    name: string
    objects: Array<{ id: string }>
  }

  const board = await prisma.board.create({
    data: {
      name: fixture.name,
      ownerId,
      objectCount: fixture.objects.length,
      currentSeq: fixture.objects.length,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  })

  const CHUNK = 1_000
  for (let start = 0; start < fixture.objects.length; start += CHUNK) {
    const slice = fixture.objects.slice(start, start + CHUNK)
    await prisma.operation.createMany({
      data: slice.map((object, i) => ({
        id: randomUUID(),
        boardId: board.id,
        seq: start + i + 1,
        type: 'CREATE' as const,
        objectId: object.id,
        payload: object as unknown as Prisma.InputJsonValue,
        actorId: ownerId,
      })),
    })
  }
}

/**
 * A handful of sticky notes per board, deterministic from the board name.
 *
 * Enough that the dashboard's object counts differ and a board opens with
 * something on it; not so many that seeding takes a coffee break.
 */
function sampleObjects(boardName: string) {
  const PALETTE = ['#FEF08A', '#FED7AA', '#BFDBFE', '#BBF7D0']
  const NOTES = [
    'What slowed us down?',
    'Ship the guard first',
    'Needs a decision by Friday',
    'Ask design for the empty state',
    'Blocked on the migration',
    'Follow up with Yuki',
  ]

  // A tiny string hash, so the same board name always seeds the same board.
  let h = 0
  for (const ch of boardName) h = (h * 31 + ch.charCodeAt(0)) >>> 0

  const count = 3 + (h % 4)
  const objects = Array.from({ length: count }, (_, i) => {
    const id = randomUUID()
    return {
      id,
      type: 'sticky' as const,
      x: 120 + (i % 3) * 240,
      y: 120 + Math.floor(i / 3) * 240,
      width: 200,
      height: 200,
      rotation: 0,
      zIndex: `a${(i + 1).toString(36).padStart(6, '0')}`,
      opacity: 1,
      createdBy: 'seed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      text: NOTES[(h + i) % NOTES.length]!,
      color: PALETTE[(h + i) % PALETTE.length]!,
      fontSize: 16,
      textAlign: 'left' as const,
    }
  })

  /*
   * Validate the seed against the real schema rather than trusting it.
   * Seed data that cannot round-trip through BoardObjectSchema is a fixture
   * that will fail the moment the load path validates — better to find that
   * here, at `pnpm db:seed`, than in a test whose failure points at the
   * loader.
   */
  return objects.map(o => BoardObjectSchema.parse(o))
}

main()
  .catch(err => {
    console.error('[seed] failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
