import { createHash, createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import * as zlib from 'node:zlib'

/**
 * A tiny S3 stand-in for development and tests — decision D13-3.
 *
 * Speaks exactly the path-style calls `lib/s3.ts` makes: PUT (direct or on a
 * presigned URL), GET, HEAD and DELETE of `/{bucket}/{key}`, plus the CORS a
 * browser needs to PUT from the app's origin and to load an image with
 * `crossOrigin="anonymous"`.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  PRESIGNED URLs ARE VERIFIED (AWS Signature V4, query form): the         │
 * │  signature, the expiry, and every signed header — so a browser PUT with  │
 * │  a different content type or length than was signed is refused, as real │
 * │  S3 refuses it. Header-signed calls (the server's own SDK requests) are │
 * │  checked for the right access key only. Unsigned GET/HEAD is allowed:   │
 * │  objects are public-read (D13-2).                                        │
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

export interface FakeS3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

/** RFC 3986 encoding as SigV4 canonicalises it. */
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest()

/**
 * Why a request is refused, or null if it may proceed. A presigned request
 * carries X-Amz-Signature in its query; anything else must at least name our
 * access key in its Authorization header.
 */
function refusal(req: IncomingMessage, credentials: FakeS3Credentials): string | null {
  const url = new URL(req.url ?? '/', 'http://x')
  const q = url.searchParams
  const signature = q.get('X-Amz-Signature')

  if (!signature) {
    // Objects are public-read (D13-2): anyone may GET or HEAD them.
    if (req.method === 'GET' || req.method === 'HEAD') return null
    const auth = req.headers.authorization ?? ''
    return auth.includes(`Credential=${credentials.accessKeyId}/`) ? null : 'unsigned'
  }

  const credential = q.get('X-Amz-Credential') ?? ''
  const [accessKey, date, region, service] = credential.split('/')
  if (accessKey !== credentials.accessKeyId) return 'unknown access key'

  const amzDate = q.get('X-Amz-Date') ?? ''
  const expires = Number(q.get('X-Amz-Expires') ?? 0)
  const issued = Date.UTC(
    Number(amzDate.slice(0, 4)),
    Number(amzDate.slice(4, 6)) - 1,
    Number(amzDate.slice(6, 8)),
    Number(amzDate.slice(9, 11)),
    Number(amzDate.slice(11, 13)),
    Number(amzDate.slice(13, 15)),
  )
  if (!Number.isFinite(issued) || Date.now() > issued + expires * 1000) return 'expired'

  const signedHeaders = (q.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean)
  const canonicalHeaders = signedHeaders
    .map(
      name =>
        `${name}:${String(req.headers[name] ?? '')
          .trim()
          .replace(/\s+/g, ' ')}\n`,
    )
    .join('')
  const canonicalQuery = [...q.entries()]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const canonicalRequest = [
    req.method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const scope = `${date}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')
  const key = hmac(
    hmac(
      hmac(hmac(`AWS4${credentials.secretAccessKey}`, date ?? ''), region ?? ''),
      service ?? '',
    ),
    'aws4_request',
  )
  const expected = createHmac('sha256', key).update(stringToSign).digest('hex')
  return expected === signature ? null : 'signature mismatch'
}

export async function startFakeS3(
  port = 0,
  host = '127.0.0.1',
  /** When given, signatures are verified. */
  credentials?: FakeS3Credentials,
): Promise<FakeS3> {
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

    const refused = credentials ? refusal(req, credentials) : null
    if (refused) {
      res.writeHead(403, { ...CORS, 'content-type': 'application/xml' })
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>${refused}</Message></Error>`,
      )
      // Drain the body so the client sees the 403, not a reset.
      req.resume()
      return
    }

    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        // A checksum in the URL is checked against the bytes, as S3 does.
        const claimed = new URL(req.url ?? '/', 'http://x').searchParams.get(
          'x-amz-checksum-crc32',
        )
        const crc32 = (zlib as { crc32?: (data: Buffer) => number }).crc32
        if (claimed && crc32) {
          const actual = Buffer.alloc(4)
          actual.writeUInt32BE(crc32(body) >>> 0)
          if (actual.toString('base64') !== claimed) {
            res.writeHead(400, { ...CORS, 'content-type': 'application/xml' })
            res.end(
              '<?xml version="1.0" encoding="UTF-8"?><Error><Code>BadDigest</Code><Message>checksum mismatch</Message></Error>',
            )
            return
          }
        }
        objects.set(key, {
          body,
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
  // The same credentials the server signs with — the repo-root `.env`.
  const { config } = await import('dotenv')
  const { resolve } = await import('node:path')
  config({ path: resolve(import.meta.dirname, '../../../../.env'), override: false })
  const port = Number(process.env.FAKE_S3_PORT ?? 4569)
  const accessKeyId = process.env.S3_ACCESS_KEY
  const secretAccessKey = process.env.S3_SECRET_KEY
  const credentials =
    accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined
  void startFakeS3(port, '127.0.0.1', credentials).then(s3 => {
    console.log(
      `fake S3 listening on ${s3.url} (in memory, ${credentials ? 'signatures verified' : 'no signature checks'})`,
    )
  })
}
