import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import type { ServerMessage, ServerOp } from '@coboard/shared'
import { env } from '../lib/env.js'
import { logger } from '../lib/logger.js'
import type { Control, Relay, RoomManager } from './RoomManager.js'

/**
 * Cross-instance fan-out over Redis pub/sub — TRD §15.2.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  v1 RUNS A SINGLE INSTANCE. This is written anyway, and deliberately.    │
 * │                                                                          │
 * │  A room is a `Map` in one process's memory. The moment a second instance │
 * │  exists, two people on the same board can land on different processes    │
 * │  and simply never see each other — and the failure is invisible in every │
 * │  test that runs one server. Retrofitting the fan-out later means         │
 * │  auditing every `broadcast` call site under time pressure.               │
 * │                                                                          │
 * │  Writing it now makes horizontal scaling a configuration change rather   │
 * │  than a rewrite, which is exactly what TRD §15.2 asks for.               │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * A SEPARATE connection, not the shared `redis()` client: a Redis connection
 * in subscriber mode may only issue subscribe/unsubscribe commands, so sharing
 * it with the rate limiter would break both.
 *
 * The envelope carries the publishing instance's id so a message is not
 * delivered twice to the room that already sent it locally.
 *
 * Three kinds cross: room messages (presence, join/leave, rename), flushed op
 * batches, and live permission changes. Ops are relayed AFTER the local 16 ms
 * batch, so a remote receiver gets the same batch a local one does.
 */

const CHANNEL = 'coboard:broadcast'

type Payload =
  | { kind: 'message'; message: ServerMessage; exceptSessionId?: string }
  | { kind: 'ops'; ops: ServerOp[] }
  | { kind: 'control'; control: Control }

type Envelope = { origin: string; boardId: string } & Payload

export class Fanout implements Relay {
  private readonly origin = randomUUID()
  private publisher: Redis | null = null
  private subscriber: Redis | null = null

  constructor(private readonly rooms: RoomManager) {}

  async start(): Promise<void> {
    const url = env().REDIS_URL
    this.publisher = new Redis(url, { maxRetriesPerRequest: 2 })
    this.subscriber = new Redis(url, { maxRetriesPerRequest: 2 })

    this.publisher.on('error', err => logger.warn({ err: err.message }, 'fanout pub'))
    this.subscriber.on('error', err => logger.warn({ err: err.message }, 'fanout sub'))

    this.subscriber.on('message', (_channel, raw) => this.receive(raw))
    await this.subscriber.subscribe(CHANNEL)
    // From here on every room broadcast, op batch and live permission change
    // on this instance also goes to the others.
    this.rooms.relay = this
  }

  /**
   * Send locally AND to the other instances.
   *
   * Local delivery is not deferred until the message comes back around: a
   * round trip through Redis would add latency to the common case (everyone on
   * one instance) to serve the rare one, against a 250 ms p95 budget.
   */
  publish(boardId: string, message: ServerMessage, exceptSessionId?: string): void {
    this.rooms.broadcast(boardId, message, exceptSessionId)
  }

  message(boardId: string, message: ServerMessage, exceptSessionId?: string): void {
    this.send(
      boardId,
      exceptSessionId === undefined
        ? { kind: 'message', message }
        : { kind: 'message', message, exceptSessionId },
    )
  }

  ops(boardId: string, ops: ServerOp[]): void {
    this.send(boardId, { kind: 'ops', ops })
  }

  control(boardId: string, control: Control): void {
    this.send(boardId, { kind: 'control', control })
  }

  private send(boardId: string, payload: Payload): void {
    const envelope: Envelope = { origin: this.origin, boardId, ...payload }
    // Fire and forget. A failed publish costs cross-instance delivery of one
    // message; failing the caller over it would be far worse. Permission
    // changes are still enforced on every op (P-1) wherever the socket is.
    void this.publisher?.publish(CHANNEL, JSON.stringify(envelope)).catch(error => {
      logger.warn({ err: error, boardId }, 'fanout publish failed')
    })
  }

  private receive(raw: string): void {
    let envelope: Envelope
    try {
      envelope = JSON.parse(raw) as Envelope
    } catch {
      return
    }
    // Our own message coming back. Already delivered locally.
    if (envelope.origin === this.origin) return
    // Delivered locally only — relaying a relayed message would loop forever.
    switch (envelope.kind) {
      case 'message':
        this.rooms.deliver(envelope.boardId, envelope.message, envelope.exceptSessionId)
        return
      case 'ops':
        this.rooms.deliverOps(envelope.boardId, envelope.ops)
        return
      case 'control':
        this.rooms.applyControl(envelope.boardId, envelope.control)
        return
    }
  }

  async stop(): Promise<void> {
    if (this.rooms.relay === this) this.rooms.relay = null
    await this.subscriber?.unsubscribe(CHANNEL).catch(() => undefined)
    this.subscriber?.disconnect()
    this.publisher?.disconnect()
    this.subscriber = null
    this.publisher = null
  }
}
