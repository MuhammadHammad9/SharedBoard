import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  ClientMessageSchema,
  CLOSE_CODES,
  SERVER_SOCKET_IDLE_TIMEOUT_MS,
} from '@coboard/shared'
import { permissionService } from '../services/PermissionService.js'
import { presenceService } from '../services/PresenceService.js'
import { prisma } from '../lib/prisma.js'
import { logger } from '../lib/logger.js'
import { redeemTicket } from '../http/routes/ws.js'
import { Fanout } from './fanout.js'
import { RoomManager, roomManager } from './RoomManager.js'
import { Session } from './Session.js'
import { handleJoin } from './handlers/join.js'
import { handleOps } from './handlers/op.js'
import { handlePresence, refreshPresence } from './handlers/presence.js'

/**
 * The WebSocket gateway — TRD §5.1, §5.6.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  AUTHENTICATION HAPPENS AT THE UPGRADE, NOT AFTER IT.                    │
 * │                                                                          │
 * │  Accepting the socket and then waiting for an auth message means an      │
 * │  unauthenticated peer holds a connection, a Session object and a place   │
 * │  in the room's memory for as long as it likes. Rejecting during the      │
 * │  upgrade costs one Redis GETDEL and never allocates any of it.           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * `noServer: true` rather than passing the HTTP server to `ws`. The upgrade is
 * handled manually so authorization can run before `handleUpgrade`, and so the
 * path can be checked — otherwise every WebSocket request to any URL on the
 * origin becomes a board socket.
 */

export const WS_PATH = '/ws'

/** Bounded so a hostile frame cannot allocate unbounded memory before Zod. */
const MAX_FRAME_BYTES = 512 * 1024

/** Matches the protocol's `op_batch` cap. A longer array is not a real client. */
const MAX_OPS_PER_MESSAGE = 100

export interface Gateway {
  wss: WebSocketServer
  rooms: RoomManager
  fanout: Fanout | null
  close: () => Promise<void>
}

export interface GatewayOptions {
  rooms?: RoomManager
  /**
   * Start the cross-instance fan-out. Off in tests, which run one process and
   * would otherwise hold two extra Redis connections open per suite.
   */
  fanout?: boolean
}

export function attachGateway(server: Server, options: GatewayOptions = {}): Gateway {
  const rooms = options.rooms ?? roomManager
  const fanout = options.fanout ? new Fanout(rooms) : null
  if (fanout) void fanout.start()

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  server.on('upgrade', (request, socket, head) => {
    void handleUpgrade(wss, rooms, request, socket, head)
  })

  /*
   * The idle sweep — R-SYNC-032.
   *
   * A half-open TCP connection does not emit `close`; it simply stops
   * delivering. Waiting for the socket to tell us it is gone can take minutes,
   * during which the room reports a participant who left, and their presence
   * cursor sits frozen on everyone's screen. The client pings every 25 s, so
   * 60 s of silence means two missed pings and is safely dead.
   */
  const sweep = setInterval(() => {
    for (const session of rooms.allSessions()) {
      if (!session.idle) continue
      logger.info({ sessionId: session.id }, 'terminating idle socket')
      leave(rooms, session)
      session.close(CLOSE_CODES.GOING_AWAY, 'idle')
    }

    /*
     * The Redis sweep — TRD §12.3, R-PERF-023. Separate from the socket sweep
     * above because it removes entries this instance may never have owned: a
     * process that died without closing its sockets leaves ghosts that only a
     * timestamp comparison can find.
     *
     * A `presence_leave` goes out for each, because a ghost removed from
     * Redis but left on everyone's screen has only moved the bug.
     */
    for (const boardId of rooms.boardIds()) {
      void presenceService.sweep(boardId).then(stale => {
        for (const sessionId of stale) {
          if (rooms.get(boardId, sessionId)) continue // still live here
          rooms.broadcast(boardId, { t: 'presence_leave', sessionId })
        }
      })
    }
  }, SERVER_SOCKET_IDLE_TIMEOUT_MS / 2)
  // Do not hold the process open for a timer whose only job is cleanup.
  sweep.unref?.()

  return {
    wss,
    rooms,
    fanout,
    close: async () => {
      clearInterval(sweep)
      rooms.dispose()
      await fanout?.stop()
      await new Promise<void>(resolve => wss.close(() => resolve()))
    },
  }
}

async function handleUpgrade(
  wss: WebSocketServer,
  rooms: RoomManager,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const reject = (status: number, reason: string) => {
    // A plain HTTP response, because the upgrade never completed — there is no
    // WebSocket yet to close with a code.
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  try {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== WS_PATH) return reject(404, 'Not Found')

    const ticket = url.searchParams.get('ticket')
    if (!ticket) return reject(401, 'Unauthorized')

    const payload = await redeemTicket(ticket)
    if (!payload) return reject(401, 'Unauthorized')

    /*
     * Re-resolve the role rather than trusting the ticket's copy.
     *
     * The ticket may be 59 seconds old, and a demotion from EDITOR to VIEWER
     * in that window must take effect — a stale role in a signed-ish blob is
     * the classic way an authorization change fails to apply (R-SEC-002).
     */
    const access = await permissionService.resolve(payload.boardId, payload.userId)
    if (!access || access.deletedAt) return reject(404, 'Not Found')
    if (access.role === 'none') return reject(403, 'Forbidden')
    const role = access.role

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { displayName: true },
    })
    if (!user) return reject(401, 'Unauthorized')

    wss.handleUpgrade(request, socket, head, ws => {
      const session = new Session(
        ws,
        payload.boardId,
        payload.userId,
        user.displayName,
        role,
      )

      if (rooms.isFull(payload.boardId)) {
        // 4029, not 4003: the client should retry in 30 s, not give up.
        session.close(CLOSE_CODES.RATE_LIMITED, 'Board is full')
        return
      }

      wire(session, rooms)
    })
  } catch (error) {
    logger.error({ err: error }, 'websocket upgrade failed')
    reject(500, 'Internal Server Error')
  }
}

function wire(session: Session, rooms: RoomManager): void {
  const socket: WebSocket = session.socket

  socket.on('message', data => {
    session.touch()
    void dispatch(session, rooms, data)
  })

  socket.on('close', () => leave(rooms, session))
  socket.on('error', error => {
    logger.debug({ err: error, sessionId: session.id }, 'socket error')
    leave(rooms, session)
  })
}

async function dispatch(
  session: Session,
  rooms: RoomManager,
  data: unknown,
): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(data))
  } catch {
    // Not JSON at all. Dropped silently: there is no message id to nack
    // against, and a peer sending garbage is not owed an explanation.
    return
  }

  const t = (parsed as { t?: unknown } | null)?.t
  if (typeof t !== 'string') return

  /*
   * ┌────────────────────────────────────────────────────────────────────┐
   * │  OP ENVELOPES ARE ROUTED ON `t` ALONE, NOT PARSED WHOLE.           │
   * │                                                                    │
   * │  The obvious version runs `ClientMessageSchema` over the frame and │
   * │  drops anything that fails. That silently swallows a well-formed   │
   * │  `{t:'op'}` carrying a malformed op — and silence is the worst     │
   * │  possible answer, because the client's outbox is waiting for an    │
   * │  ack or a nack and will retry the same bad op forever.             │
   * │                                                                    │
   * │  TRD §5.4 step 2 requires an INVALID_OP nack, so the ops go to     │
   * │  `handleOps` as raw values and it validates each one against       │
   * │  `ClientOpSchema` individually — which is also what lets one bad   │
   * │  op in a batch of forty be refused without discarding the other    │
   * │  thirty-nine. Found by the socket suite; the outer schema was      │
   * │  quietly doing the rejecting and nobody was being told.            │
   * └────────────────────────────────────────────────────────────────────┘
   */
  if (t === 'op' || t === 'op_batch') {
    if (!session.joined) return
    const raw = parsed as { op?: unknown; ops?: unknown }
    const ops = t === 'op' ? [raw.op] : Array.isArray(raw.ops) ? raw.ops : []
    if (ops.length === 0 || ops.length > MAX_OPS_PER_MESSAGE) return
    await handleOps(session, rooms, ops)
    return
  }

  // Everything else is fully validated up front: there is no per-item nack to
  // deliver, so a frame that does not match its schema has nowhere to go.
  const message = ClientMessageSchema.safeParse(parsed)
  if (!message.success) return

  switch (message.data.t) {
    case 'ping':
      // The heartbeat doubles as the presence TTL refresh — see
      // `refreshPresence` for why it is not done per cursor message.
      if (session.joined) refreshPresence(session)
      session.send({ t: 'pong' })
      return

    case 'join':
      /*
       * The board id in the message must match the one the ticket was issued
       * for. Without this check a ticket for a board you CAN read becomes a
       * join to any board you name — the authorization would have been done
       * against the wrong resource entirely.
       */
      if (message.data.boardId !== session.boardId) {
        session.close(CLOSE_CODES.FORBIDDEN, 'Board mismatch')
        return
      }
      await handleJoin(session, rooms, message.data.sinceSeq)
      return

    // Presence — relayed, never persisted (R-SYNC-001).
    case 'cursor':
    case 'sel':
    case 'stroke':
    case 'xform':
      handlePresence(session, rooms, message.data)
      return

    // Handled above, before the full parse.
    case 'op':
    case 'op_batch':
      return
  }
}

function leave(rooms: RoomManager, session: Session): void {
  if (!session.joined) {
    rooms.leave(session)
    return
  }
  session.joined = false
  rooms.leave(session)
  void presenceService.forget(session.boardId, session.id)
  rooms.broadcast(session.boardId, { t: 'presence_leave', sessionId: session.id })
}
