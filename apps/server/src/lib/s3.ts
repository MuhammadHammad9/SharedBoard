import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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
  contentDisposition?: string | undefined
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
  presignPut(
    key: string,
    contentType: string,
    size: number,
    contentDisposition?: string,
  ): Promise<string> {
    return getSignedUrl(
      s3(),
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        ContentType: contentType,
        ContentLength: size,
        ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
      }),
      {
        expiresIn: PRESIGN_SECONDS,
        // Without this the SDK signs only content-length and host, and a
        // browser could PUT any content type on the URL. The disposition is
        // signed too when there is one, so a PUT that drops it is refused.
        signableHeaders: new Set(
          contentDisposition ? ['content-type', 'content-disposition'] : ['content-type'],
        ),
      },
    )
  },

  async head(key: string): Promise<StoredObject | null> {
    try {
      const out = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
      return {
        size: out.ContentLength ?? 0,
        contentType: out.ContentType,
        contentDisposition: out.ContentDisposition,
      }
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

  async put(
    key: string,
    body: Uint8Array | string,
    contentType: string,
    contentDisposition?: string,
  ): Promise<void> {
    await s3().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
        // Thumbnails are replaced under new keys; images never change.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    )
  },

  /** Every key under a prefix, with when it was written. Paginates. */
  async list(
    prefix: string,
    max = 10_000,
  ): Promise<Array<{ key: string; modified: Date }>> {
    const out: Array<{ key: string; modified: Date }> = []
    let token: string | undefined
    do {
      const page = await s3().send(
        new ListObjectsV2Command({
          Bucket: bucket(),
          Prefix: prefix,
          ContinuationToken: token,
        }),
      )
      for (const item of page.Contents ?? []) {
        if (item.Key)
          out.push({ key: item.Key, modified: item.LastModified ?? new Date(0) })
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token && out.length < max)
    return out
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

/**
 * The shape of an upload's key: `boards/<board uuid>/<object uuid>.<ext>`.
 * The board segment names the board the upload was AUTHORIZED for, which is
 * not necessarily the board an image op places it on — a paste between boards
 * reuses the URL, and the image collector keeps it alive by reference.
 */
export const UPLOAD_KEY =
  /^boards\/([0-9a-f-]{36})\/[0-9a-f-]{36}\.(png|jpg|gif|webp|svg)$/

/**
 * Whether an image object's `url` points at one of OUR uploads — finding 19.
 *
 * The shared schema accepts any URL so the client stays environment-agnostic;
 * the server narrows it here, on every CREATE and UPDATE that carries one.
 * Without this an image op can make every viewer's browser fetch an arbitrary
 * third-party URL (a tracking pixel that logs each member's IP, or a request
 * into their local network), and the board would render whatever lives there.
 * Uploads are always stored as absolute URLs under the storage public base
 * (`publicUrl`), so that is the only form accepted; there are no relative
 * image URLs in this codebase.
 */
export function isStorageImageUrl(url: string): boolean {
  if (!storageConfigured()) return false
  const key = storage.keyOf(url)
  return key !== null && UPLOAD_KEY.test(key)
}

/**
 * An avatar's key: `avatars/<user uuid>/<object uuid>.<ext>` — D-36. Raster
 * only: an avatar is shown as a small `<img>` on other people's screens, and
 * there is nothing an SVG adds there that is worth the sanitizer round trip.
 */
export const AVATAR_KEY = /^avatars\/([0-9a-f-]{36})\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/

/** The avatar key `url` points at if it is one of THIS user's uploads, else null. */
export function ownAvatarKey(
  url: string | null | undefined,
  userId: string,
): string | null {
  if (!url || !storageConfigured()) return null
  const key = storage.keyOf(url)
  const match = key ? AVATAR_KEY.exec(key) : null
  return match && match[1] === userId ? key : null
}

/** Tests point the client at a fresh endpoint between suites. */
export function resetStorageClient(): void {
  client = null
}
