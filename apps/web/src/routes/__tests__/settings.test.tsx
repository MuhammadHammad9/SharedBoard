/**
 * @vitest-environment happy-dom
 *
 * S-16 settings — FR-SET-001 (avatar, D-36) and FR-AUTH-007 (logout clears
 * the in-memory board caches).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { auth, errors } from '../../lib/strings.js'
import { authStore } from '../../stores/authStore.js'
import Settings from '../Settings.js'

const USER = {
  id: 'user-1',
  email: 'priya@example.com',
  displayName: 'Priya Raman',
  avatarUrl: null as string | null,
  hasPassword: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const AVATAR = 'https://cdn.example.com/avatars/user-1/a.png'

let calls: Array<{ url: string; method: string; body: unknown }> = []

const json = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      })
      if (url.endsWith('/uploads/avatar/presign')) {
        return Promise.resolve(
          json({
            uploadUrl: 'https://storage.example.com/put-here',
            key: 'avatars/user-1/a.png',
            headers: { 'content-type': 'image/png' },
          }),
        )
      }
      if (url === 'https://storage.example.com/put-here') {
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      if (url.endsWith('/uploads/avatar/confirm')) {
        return Promise.resolve(json({ user: { ...USER, avatarUrl: AVATAR } }))
      }
      if (url.endsWith('/auth/me') && method === 'PATCH') {
        return Promise.resolve(json({ user: { ...USER, avatarUrl: null } }))
      }
      if (url.endsWith('/auth/logout')) return Promise.resolve(json(null, 204))
      return Promise.resolve(json({}))
    }),
  )
}

function renderSettings(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/" element={<div data-testid="landing" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const png = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'me.png', {
    type: 'image/png',
  })

beforeEach(() => {
  calls = []
  stub()
  authStore.getState().setSession({ ...USER }, 'token')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('logout from Settings — FR-AUTH-007', () => {
  it('clears the cached board lists and returns to S-01', async () => {
    const client = new QueryClient()
    client.setQueryData(['boards', 'all', 'lastEdited', ''], { pages: [] })
    renderSettings(client)

    await userEvent.click(screen.getByTestId('logout'))

    expect(await screen.findByTestId('landing')).toBeTruthy()
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })
})

describe('the avatar — FR-SET-001, D-36', () => {
  it('uploads through presign → PUT → confirm, and never sends a URL of its own', async () => {
    renderSettings()
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [png()] } })

    await waitFor(() => expect(authStore.getState().user?.avatarUrl).toBe(AVATAR))
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'POST /api/uploads/avatar/presign',
      'PUT https://storage.example.com/put-here',
      'POST /api/uploads/avatar/confirm',
    ])
    expect(calls[0]!.body).toEqual({ contentType: 'image/png', size: 4 })
    expect(calls[2]!.body).toEqual({ key: 'avatars/user-1/a.png' })
    expect(await screen.findByText(auth.settings.avatarSaved)).toBeTruthy()
    const img = screen.getByAltText(auth.settings.avatarAlt(USER.displayName))
    expect(img.getAttribute('src')).toBe(AVATAR)
  })

  it('refuses an SVG before uploading anything', async () => {
    renderSettings()
    const svg = new File(['<svg/>'], 'me.svg', { type: 'image/svg+xml' })
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [svg] } })

    expect(await screen.findByText(auth.settings.avatarUnsupported)).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('refuses a file over 10 MB before uploading anything (E-05)', async () => {
    renderSettings()
    const big = png()
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 })
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [big] } })

    expect(await screen.findByText(errors.uploadTooLarge)).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('removes the avatar with avatarUrl: null', async () => {
    authStore.getState().setSession({ ...USER, avatarUrl: AVATAR }, 'token')
    renderSettings()

    await userEvent.click(screen.getByTestId('avatar-remove'))

    await waitFor(() => expect(authStore.getState().user?.avatarUrl).toBeNull())
    expect(calls).toEqual([
      { url: '/api/auth/me', method: 'PATCH', body: { avatarUrl: null } },
    ])
    expect(screen.queryByTestId('avatar-remove')).toBeNull()
  })
})
