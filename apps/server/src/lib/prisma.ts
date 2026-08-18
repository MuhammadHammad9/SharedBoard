import { PrismaClient } from '@prisma/client'

/**
 * One Prisma client for the process.
 *
 * Held on `globalThis` so `tsx watch` does not open a new connection pool on
 * every reload — a few dozen edits and Postgres refuses new connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
