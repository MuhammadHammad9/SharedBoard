import { describe, expect, it } from 'vitest'
import { sniffImageType } from '../lib/fileType.js'

/** R-SEC-012 — the bytes decide what a file is. */

const bytes = (...b: number[]) => new Uint8Array(b)
const text = (s: string) => new TextEncoder().encode(s)

describe('sniffImageType', () => {
  it.each([
    ['image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)],
    ['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xdb)],
    ['image/gif', text('GIF89a....')],
    ['image/gif', text('GIF87a....')],
    ['image/webp', text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')],
    ['image/svg+xml', text('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    [
      'image/svg+xml',
      text('﻿<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg>\n<svg>'),
    ],
  ])('%s', (type, input) => {
    expect(sniffImageType(input)).toBe(type)
  })

  it.each([
    ['an executable', bytes(0x4d, 0x5a, 0x90, 0)],
    ['HTML', text('<!doctype html><html><svg></svg></html>')],
    ['a RIFF that is not WebP', text('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')],
    ['text with a NUL', new Uint8Array([...text('<svg>'), 0])],
    ['nothing', new Uint8Array()],
  ])('refuses %s', (_name, input) => {
    expect(sniffImageType(input)).toBeNull()
  })
})
