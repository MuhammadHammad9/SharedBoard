import { createServer, type Server } from 'node:http'

/**
 * A tiny S3 stand-in for development and tests — decision D13-3.
 *
 * Speaks exactly the path-style calls `lib/s3.ts` makes: PUT (direct or on a
 * presigned URL), GET, HEAD and DELETE of `/{bucket}/{key}`, plus the CORS a
 * browser needs to PUT from the app's origin and to load an image with
 * `crossOrigin="anonymous"`.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  It does NOT verify signatures. Real S3 (or MinIO) enforces the presign: │
 * │  expiry, content type and length. What the test suite proves with this   │
 * │  is OUR side — nothing is signed before validation, and nothing is kept  │
 * │  whose bytes are not an accepted image.                                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * No npm emulator is used: the one that fits (s3rver) pulls in a parser with
 * an unpatched high-severity advisory, which R-SEC-019 would block on.
 *
 * In memory. Restarting it forgets every object, which suits both uses.
 */

interface Stored {
  body: Buffer
  contentType: string
}

export interface FakeS3 {
  server: Server
  port: number
  url: string
  objects: Map<string, Stored>
  close: () => Promise<void>
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, HEAD, DELETE',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'ETag',
}

const notFound = (key: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>${key.replace(/[<>&]/g, '')}</Key></Error>`

export async function startFakeS3(port = 0, host = '127.0.0.1'): Promise<FakeS3> {
  const objects = new Map<string, Stored>()

  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    const key = path.replace(/^\/+/, '') // "bucket/key/with/slashes"

    // A readiness probe for Playwright's webServer, which wants a 2xx.
    if (key === '' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('fake S3')
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end()
      return
    }

    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        objects.set(key, {
          body: Buffer.concat(chunks),
          contentType: req.headers['content-type'] ?? 'application/octet-stream',
        })
        res.writeHead(200, { ...CORS, etag: `"${objects.size}"` }).end()
      })
      return
    }

    const stored = objects.get(key)
    if (req.method === 'DELETE') {
      objects.delete(key)
      res.writeHead(204, CORS).end()
      return
    }
    if (!stored) {
      res.writeHead(404, { ...CORS, 'content-type': 'application/xml' })
      res.end(req.method === 'HEAD' ? undefined : notFound(key))
      return
    }
    res.writeHead(200, {
      ...CORS,
      'content-type': stored.contentType,
      'content-length': String(stored.body.length),
    })
    res.end(req.method === 'HEAD' ? undefined : stored.body)
  })

  await new Promise<void>(resolve => server.listen(port, host, resolve))
  const actual = (server.address() as { port: number }).port
  return {
    server,
    port: actual,
    url: `http://${host}:${actual}`,
    objects,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

// `tsx src/dev/fakeS3.ts` — the dev and Playwright storage.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_S3_PORT ?? 4569)
  void startFakeS3(port).then(s3 => {
    console.log(`fake S3 listening on ${s3.url} (in memory, no signature checks)`)
  })
}
