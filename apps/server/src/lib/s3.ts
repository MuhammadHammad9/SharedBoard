import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env, storageConfigured } from './env.js'

/**
 * S3-compatible object storage — TRD §4.4, decision D-12.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  IMAGE BYTES NEVER PASS THROUGH NODE.                                    │
 * │                                                                          │
 * │  The browser PUTs straight to storage on a presigned URL. The server     │
 * │  signs, and afterwards reads the object back once to check it (magic     │
 * │  bytes, SVG sanitization). A 10 MB upload proxied through the event loop │
 * │  stalls every socket on the instance for its duration.                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Objects are public-read under unguessable keys (decision D13-2): an image
 * op stores a plain URL, which must load for every member and guest without a
 * signed-URL refresh path.
 */

export interface StoredObject {
  size: number
  contentType: string | undefined
}

/** Presigned URLs live this long — long enough for a slow 10 MB upload. */
const PRESIGN_SECONDS = 10 * 60

let client: S3Client | null = null

function s3(): S3Client {
  if (!storageConfigured()) throw new Error('Object storage is not configured')
  client ??= new S3Client({
    endpoint: env().S3_ENDPOINT,
    region: env().S3_REGION,
    // Path-style (`endpoint/bucket/key`): what MinIO and the local fake speak,
    // and what S3 itself still accepts.
    forcePathStyle: true,
    /*
     * Checksums only where S3 demands them. The SDK's default computes one
     * for every request — including a presigned PUT, where it checksums the
     * EMPTY body at signing time (`x-amz-checksum-crc32=AAAAAA==`) and S3
     * then rejects the real bytes the browser sends. Found by the fake S3
     * verifying what real S3 verifies.
     */
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: env().S3_ACCESS_KEY!,
      secretAccessKey: env().S3_SECRET_KEY!,
    },
  })
  return client
}

const bucket = () => env().S3_BUCKET

export const storage = {
  /**
   * A URL the browser may PUT exactly these bytes to. Content type and length
   * are part of the signature, so real S3 refuses anything else.
   */
  presignPut(key: string, contentType: string, size: number): Promise<string> {
    return getSignedUrl(
      s3(),
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        ContentType: contentType,
        ContentLength: size,
      }),
      {
        expiresIn: PRESIGN_SECONDS,
        // Without this the SDK signs only content-length and host, and a
        // browser could PUT any content type on the URL.
        signableHeaders: new Set(['content-type']),
      },
    )
  },

  async head(key: string): Promise<StoredObject | null> {
    try {
      const out = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
      return { size: out.ContentLength ?? 0, contentType: out.ContentType }
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode
      if (status === 404 || (error as Error).name === 'NotFound') return null
      throw error
    }
  },

  async read(key: string): Promise<Uint8Array> {
    const out = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
    return out.Body ? out.Body.transformToByteArray() : new Uint8Array()
  },

  async put(key: string, body: Uint8Array | string, contentType: string): Promise<void> {
    await s3().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: contentType,
        // Thumbnails are replaced under new keys; images never change.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    )
  },

  async remove(key: string): Promise<void> {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
  },

  publicUrl(key: string): string {
    const base = env().S3_PUBLIC_URL ?? `${env().S3_ENDPOINT}/${bucket()}`
    return `${base.replace(/\/$/, '')}/${key}`
  },

  /** The key a public URL points at, or null if it is not one of ours. */
  keyOf(url: string): string | null {
    const base = (env().S3_PUBLIC_URL ?? `${env().S3_ENDPOINT}/${bucket()}`).replace(
      /\/$/,
      '',
    )
    return url.startsWith(`${base}/`) ? url.slice(base.length + 1) : null
  },
}

/** Tests point the client at a fresh endpoint between suites. */
export function resetStorageClient(): void {
  client = null
}
