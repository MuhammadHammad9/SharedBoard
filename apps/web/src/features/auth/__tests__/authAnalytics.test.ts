import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordedEvents } from '../../../lib/analytics.js'

/** PRD §9 account_created / logged_in from the password auth calls. */

const api = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../../lib/api.js', () => ({ api }))

const { login, register } = await import('../api.js')

const response = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'maya.okafor@example.com',
    displayName: 'Maya Okafor',
    avatarUrl: null,
    hasPassword: true,
    createdAt: '2026-10-01T00:00:00.000Z',
  },
  accessToken: 'token',
}

const authEvents = (from: number) =>
  recordedEvents()
    .slice(from)
    .filter(e => e.event === 'account_created' || e.event === 'logged_in')

beforeEach(() => {
  api.post.mockReset()
})

describe('auth analytics', () => {
  it('register sends account_created with the method and nothing personal', async () => {
    api.post.mockResolvedValue(response)
    const start = recordedEvents().length
    await register({
      email: 'maya.okafor@example.com',
      password: 'pw',
      displayName: 'Maya',
    })
    expect(authEvents(start)).toEqual([
      expect.objectContaining({
        event: 'account_created',
        props: { method: 'password' },
      }),
    ])
  })

  it('login sends logged_in', async () => {
    api.post.mockResolvedValue(response)
    const start = recordedEvents().length
    await login({ email: 'maya.okafor@example.com', password: 'pw' })
    expect(authEvents(start)).toEqual([
      expect.objectContaining({ event: 'logged_in', props: { method: 'password' } }),
    ])
  })

  it('a failed login sends nothing', async () => {
    api.post.mockRejectedValue(new Error('401'))
    const start = recordedEvents().length
    await expect(
      login({ email: 'maya.okafor@example.com', password: 'x' }),
    ).rejects.toThrow()
    expect(authEvents(start)).toEqual([])
  })
})
