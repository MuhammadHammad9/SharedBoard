/**
 * Shared constants imported by BOTH client and server.
 *
 * R-ARCH-007 (Blocking): duplicating any of this across the boundary is
 * forbidden. The server assigns presence colours and validates sticky colours,
 * so these cannot live only in the client.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Frozen palettes — PRD §15
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Presence palette — 12 colours, assigned round-robin per room, server-side.
 *
 * R-UI-013 (Blocking): FROZEN. A user's colour must render identically for
 * every participant, so it carries protocol meaning and cannot be themed.
 */
export const PRESENCE_COLOURS = [
  '#EF4444',
  '#F97316',
  '#EAB308',
  '#84CC16',
  '#22C55E',
  '#14B8A6',
  '#06B6D4',
  '#3B82F6',
  '#6366F1',
  '#A855F7',
  '#EC4899',
  '#F43F5E',
] as const

export type PresenceColour = (typeof PRESENCE_COLOURS)[number]

/**
 * Sticky note palette — 8 colours.
 *
 * R-UI-014 (Blocking): FROZEN. A sticky's colour is a persisted object
 * property, so changing these changes stored data.
 */
export const STICKY_COLOURS = {
  yellow: '#FEF08A',
  orange: '#FED7AA',
  pink: '#FBCFE8',
  red: '#FECACA',
  purple: '#E9D5FF',
  blue: '#BFDBFE',
  green: '#BBF7D0',
  grey: '#E4E4E7',
} as const

export type StickyColourName = keyof typeof STICKY_COLOURS
export type StickyColour = (typeof STICKY_COLOURS)[StickyColourName]

export const STICKY_COLOUR_VALUES = Object.values(
  STICKY_COLOURS,
) as readonly StickyColour[]

/** Pen tool swatches — 10 colours plus custom (FR-CANVAS-005). */
export const PEN_COLOURS = [
  '#18181B',
  '#71717A',
  '#EF4444',
  '#F97316',
  '#EAB308',
  '#22C55E',
  '#14B8A6',
  '#3B82F6',
  '#6366F1',
  '#EC4899',
] as const

/* ────────────────────────────────────────────────────────────────────────────
 * Coordinate and viewport bounds
 * ──────────────────────────────────────────────────────────────────────────── */

/** R-COORD-003 (Blocking) — clamp on creation, client and server. FR-CANVAS-001. */
export const COORD_MIN = -1_000_000
export const COORD_MAX = 1_000_000

/** Derived bound for width/height, which can span the full coordinate range. */
export const SIZE_MAX = 2_000_000

/** R-COORD-006 — zoom clamps hard at both ends. FR-CANVAS-003: 10%–500%. */
export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 5

/** FR-CANVAS-012 — minimum object size in canvas coordinates. */
export const MIN_OBJECT_SIZE = 8

/** Device pixel ratio cap — R-CANVAS-020. 3x quadruples fill cost for no gain. */
export const MAX_DPR = 2

/** Below this zoom, strokes render as polylines with no curve interpolation. */
export const POLYLINE_ZOOM_THRESHOLD = 0.25

/** Culling margin in screen pixels, divided by zoom at use site. */
export const CULL_PADDING_PX = 100

/** Screen-space hit tolerance, divided by zoom. Keeps 1px lines clickable. */
export const HIT_TOLERANCE_PX = 4

/** Minimum handle touch target in screen pixels (FLOWS E-11). 44 on touch. */
export const MIN_HANDLE_TARGET_PX = 8
export const MIN_HANDLE_TARGET_TOUCH_PX = 44

/* ────────────────────────────────────────────────────────────────────────────
 * Object limits
 * ──────────────────────────────────────────────────────────────────────────── */

export const STROKE_WIDTH_MIN = 1
export const STROKE_WIDTH_MAX = 24
export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 128
export const STICKY_TEXT_MAX = 2_000
export const TEXT_MAX = 5_000
export const BOARD_NAME_MAX = 80
export const DISPLAY_NAME_MAX = 40

/** Stroke points are a flat number[] with stride 3: [x, y, pressure, ...]. */
export const STROKE_POINT_STRIDE = 3
export const STROKE_POINTS_MIN = 6 // two points
export const STROKE_POINTS_MAX = 30_000 // 10k points

/** Default sticky note size in canvas units (FR-CANVAS-008). */
export const STICKY_DEFAULT_SIZE = 200

/** Ramer-Douglas-Peucker epsilon, in canvas units. Run once on pointerup. */
export const SIMPLIFY_EPSILON = 0.5

/* ────────────────────────────────────────────────────────────────────────────
 * Board and room limits — PRD §7.2
 * ──────────────────────────────────────────────────────────────────────────── */

export const MAX_OBJECTS_PER_BOARD = 50_000
export const OBJECT_COUNT_SOFT_WARNING = 10_000
export const MAX_USERS_PER_ROOM = 50
export const SNAPSHOT_INTERVAL_OPS = 500
export const SNAPSHOT_RETENTION = 3
export const TRASH_RETENTION_DAYS = 30

/* ────────────────────────────────────────────────────────────────────────────
 * Sync timings — TRD §5, §10
 * ──────────────────────────────────────────────────────────────────────────── */

/** Presence send rate: 20 Hz. R-SYNC-040. */
export const PRESENCE_THROTTLE_MS = 50

/** Above this many selected objects, throttle presence harder (FLOWS E-07). */
export const PRESENCE_HEAVY_SELECTION_THRESHOLD = 100
export const PRESENCE_HEAVY_THROTTLE_MS = 100

/** Sticky note text update debounce while typing (FLOWS §8.2.2). */
export const TEXT_UPDATE_DEBOUNCE_MS = 300

/** Server broadcast batching window, one animation frame. TRD §5.5. */
export const BROADCAST_BATCH_MS = 16

/** Heartbeat — TRD §5.1, R-SYNC-032. */
export const PING_INTERVAL_MS = 25_000
export const PONG_TIMEOUT_MS = 10_000
export const SERVER_SOCKET_IDLE_TIMEOUT_MS = 60_000

/** Reconnection — TRD §10.2, R-SYNC-030 full jitter. */
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_MAX_MS = 30_000
export const MAX_RECONNECT_ATTEMPTS = 8

/** Outbox — TRD §10.1. */
export const OUTBOX_FLUSH_BATCH_SIZE = 50
export const OUTBOX_WARNING_THRESHOLD = 500
export const OFFLINE_WARNING_MS = 10 * 60 * 1_000

/** Gap fill debounce — TRD §6.3. */
export const GAP_FILL_DEBOUNCE_MS = 500

/** Cursor idle behaviour — FLOWS §9.2. */
export const CURSOR_FADE_MS = 5_000
export const CURSOR_HIDE_MS = 15_000
export const CURSOR_INTERPOLATE_MS = 50

/** Presence sweep for stale entries — TRD §12.3. */
export const PRESENCE_SWEEP_IDLE_MS = 60_000

/** History — R-UNDO-009, R-UNDO-005. */
export const HISTORY_MAX_ENTRIES = 100
export const HISTORY_MAX_STALE_SKIPS = 10
export const HISTORY_COALESCE_MS = 1_000

/** Tombstones — R-CONV-004. */
export const TOMBSTONE_CAP = 10_000

/** Image cache — R-CANVAS-025. */
export const IMAGE_CACHE_CAP = 100

/* ────────────────────────────────────────────────────────────────────────────
 * Security limits — PRD §7.4, TRD §11
 * ──────────────────────────────────────────────────────────────────────────── */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128
export const BCRYPT_COST = 12

/** Rate limits — R-SEC-013. */
export const RATE_LIMIT_OPS_PER_SEC = 100
export const RATE_LIMIT_LOGIN_ATTEMPTS = 5
export const RATE_LIMIT_LOGIN_WINDOW_MS = 15 * 60 * 1_000
export const RATE_LIMIT_LOGIN_PER_IP = 20
export const RATE_LIMIT_UPLOADS_PER_HOUR = 20

/** Share tokens — R-SEC-009. 32 bytes = 256 bits, well above the 128-bit floor. */
export const SHARE_TOKEN_BYTES = 32

/** Token lifetimes — TRD §11.1. */
export const ACCESS_TOKEN_TTL = '15m'
export const REFRESH_TOKEN_TTL = '30d'
export const WS_TICKET_TTL_MS = 60_000
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1_000

/** Permission cache — R-SEC-020. */
export const PERMISSION_CACHE_TTL_MS = 60_000

/* ────────────────────────────────────────────────────────────────────────────
 * Export — FLOWS §11
 * ──────────────────────────────────────────────────────────────────────────── */

export const EXPORT_MAX_DIMENSION = 8_192
export const EXPORT_CHUNK_THRESHOLD = 2_000
export const EXPORT_URL_REVOKE_MS = 60_000
export const THUMBNAIL_WIDTH = 640
export const THUMBNAIL_HEIGHT = 400
export const THUMBNAIL_QUALITY = 0.7
export const THUMBNAIL_PADDING_RATIO = 0.05
export const THUMBNAIL_INTERVAL_MS = 5 * 60 * 1_000

/* ────────────────────────────────────────────────────────────────────────────
 * Roles
 * ──────────────────────────────────────────────────────────────────────────── */

export const ROLES = ['OWNER', 'EDITOR', 'VIEWER'] as const
export type Role = (typeof ROLES)[number]

export const EDIT_ROLES: readonly Role[] = ['OWNER', 'EDITOR']

/** R-SEC-001 — mirrored server-side on every message. Client use is UX only. */
export const canEdit = (role: Role): boolean => EDIT_ROLES.includes(role)

/* ────────────────────────────────────────────────────────────────────────────
 * WebSocket close codes — TRD §5.6
 * ──────────────────────────────────────────────────────────────────────────── */

export const CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  ABNORMAL: 1006,
  UNAUTHORIZED: 4001,
  FORBIDDEN: 4003,
  NOT_FOUND: 4004,
  RATE_LIMITED: 4029,
} as const
