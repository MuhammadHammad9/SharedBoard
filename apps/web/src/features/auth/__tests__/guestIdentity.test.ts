import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRESENCE_COLOURS } from '@coboard/shared'
import {
  clearGuest,
  readGuest,
  rememberShareToken,
  saveGuest,
  shareTokenFor,
} from '../guestIdentity.js'

/** FR-AUTH-006, FLOWS §7.2, E-18. */

function storage(): Map<string, string> {
  const map = new Map<string, string>()
  return Object.assign(map, {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  })
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage())
  vi.stubGlobal('sessionStorage', storage())
  clearGuest()
})

afterEach(() => vi.unstubAllGlobals())

describe('guest identity', () => {
  it('persists { id, name, colour } under coboard.guest', () => {
    const saved = saveGuest('  Marcus  ')
    expect(saved.name).toBe('Marcus')
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(PRESENCE_COLOURS).toContain(saved.colour)
    expect(JSON.parse(localStorage.getItem('coboard.guest')!)).toEqual(saved)
    expect(readGuest()).toEqual(saved)
  })

  it('keeps the same id and colour when the name changes', () => {
    const first = saveGuest('Marcus')
    const second = saveGuest('Marcus L.')
    expect(second.id).toBe(first.id)
    expect(second.colour).toBe(first.colour)
  })

  it('ignores a hand-edited or malformed entry', () => {
    localStorage.setItem(
      'coboard.guest',
      JSON.stringify({ id: 'x', name: 'M', colour: '#fff' }),
    )
    expect(readGuest()).toBeNull()
    localStorage.setItem('coboard.guest', '{not json')
    expect(readGuest()).toBeNull()
  })

  it('"Not you?" forgets the identity', () => {
    saveGuest('Marcus')
    clearGuest()
    expect(readGuest()).toBeNull()
  })

  it('E-18: works in memory, silently, when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    const saved = saveGuest('Marcus')
    expect(readGuest()).toEqual(saved)
  })
})

describe('the share token', () => {
  it('is kept per board for this tab', () => {
    rememberShareToken('board-a', 'tok-a')
    rememberShareToken('board-b', 'tok-b')
    expect(shareTokenFor('board-a')).toBe('tok-a')
    expect(shareTokenFor('board-b')).toBe('tok-b')
    expect(sessionStorage.getItem('coboard.share.board-a')).toBe('tok-a')
    expect(shareTokenFor('board-c')).toBeNull()
  })
})
