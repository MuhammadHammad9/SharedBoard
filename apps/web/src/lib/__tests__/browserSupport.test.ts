// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errors } from '../strings.js'
import { missingBrowserFeatures } from '../browserSupport.js'

describe('browser support — PRD §7.6', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('index.html carries errors.unsupportedBrowser verbatim, for IE', () => {
    const html = readFileSync(join(__dirname, '../../../index.html'), 'utf8')
    expect(html).toContain(errors.unsupportedBrowser)
    // Only the nomodule script may reveal it — a module-capable browser never does.
    expect(html).toMatch(/<script nomodule>[\s\S]*unsupported-browser/)
    expect(html).toMatch(/id="unsupported-browser"\s+style="\s*display: none;/)
  })

  it('names the API a browser is missing', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    expect(missingBrowserFeatures()).toContain('ResizeObserver')
  })
})
