import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BoardObjectSchema,
  OP_PAYLOAD_MAX_BYTES,
  ServerOpSchema,
  UpdatePayloadByType,
  UpdatePayloadSchema,
  ClientOpSchema,
  ClientMessageSchema,
  PRESENCE_COLOURS,
  RegisterSchema,
  STICKY_COLOURS,
  ServerMessageSchema,
  StrokeObjectSchema,
  isPresenceMessage,
} from '../index.js'

const baseFields = {
  id: '11111111-1111-4111-8111-111111111111',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  zIndex: 'a0',
  opacity: 1,
  createdBy: 'user-1',
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_000_000,
}

const validStroke = {
  ...baseFields,
  type: 'stroke' as const,
  points: [0, 0, 0.5, 10, 10, 0.5],
  color: '#18181B',
  strokeWidth: 2,
  simplified: true,
}

describe('R-SEC-004 — reject NaN and Infinity, never coerce', () => {
  it('rejects Infinity in a coordinate', () => {
    // An Infinity here propagates through the renderer and blanks the canvas
    // for EVERY user in the room. Both a bug and a DoS vector.
    expect(StrokeObjectSchema.safeParse({ ...validStroke, x: Infinity }).success).toBe(
      false,
    )
    expect(StrokeObjectSchema.safeParse({ ...validStroke, y: -Infinity }).success).toBe(
      false,
    )
  })

  it('rejects NaN in a coordinate', () => {
    expect(StrokeObjectSchema.safeParse({ ...validStroke, x: NaN }).success).toBe(false)
  })

  it('rejects Infinity inside the stroke point array', () => {
    expect(
      StrokeObjectSchema.safeParse({ ...validStroke, points: [0, 0, 0, Infinity, 1, 1] })
        .success,
    ).toBe(false)
  })

  it('rejects coordinates beyond the ±1,000,000 clamp — FLOWS E-04', () => {
    expect(StrokeObjectSchema.safeParse({ ...validStroke, x: 2_000_000 }).success).toBe(
      false,
    )
  })
})

describe('object schemas', () => {
  it('accepts a well-formed stroke', () => {
    expect(StrokeObjectSchema.safeParse(validStroke).success).toBe(true)
  })

  it('requires at least two points (stride 3)', () => {
    expect(
      StrokeObjectSchema.safeParse({ ...validStroke, points: [0, 0, 1] }).success,
    ).toBe(false)
  })

  it('enforces stroke width bounds 1–24', () => {
    expect(StrokeObjectSchema.safeParse({ ...validStroke, strokeWidth: 0 }).success).toBe(
      false,
    )
    expect(
      StrokeObjectSchema.safeParse({ ...validStroke, strokeWidth: 25 }).success,
    ).toBe(false)
  })

  it('requires #RRGGBB colours', () => {
    expect(StrokeObjectSchema.safeParse({ ...validStroke, color: 'red' }).success).toBe(
      false,
    )
    expect(StrokeObjectSchema.safeParse({ ...validStroke, color: '#FFF' }).success).toBe(
      false,
    )
  })

  it('requires zIndex to be a STRING — fractional indexing, TRD §6.4', () => {
    expect(StrokeObjectSchema.safeParse({ ...validStroke, zIndex: 5 }).success).toBe(
      false,
    )
  })

  it('restricts sticky colours to the frozen palette — R-UI-014', () => {
    const sticky = {
      ...baseFields,
      type: 'sticky' as const,
      text: 'hello',
      color: STICKY_COLOURS.yellow,
      fontSize: 'auto' as const,
      textAlign: 'center' as const,
    }
    expect(BoardObjectSchema.safeParse(sticky).success).toBe(true)
    expect(BoardObjectSchema.safeParse({ ...sticky, color: '#123456' }).success).toBe(
      false,
    )
  })
})

describe('op schemas — TRD §5.2', () => {
  it('accepts a CREATE carrying a full object', () => {
    expect(
      ClientOpSchema.safeParse({
        id: '22222222-2222-4222-8222-222222222222',
        type: 'CREATE',
        objectId: validStroke.id,
        payload: validStroke,
      }).success,
    ).toBe(true)
  })

  it('accepts a PARTIAL UPDATE payload — R-CONV-002', () => {
    // Partial payloads are what let "A moves it, B recolours it" preserve both.
    expect(
      ClientOpSchema.safeParse({
        id: '33333333-3333-4333-8333-333333333333',
        type: 'UPDATE',
        objectId: validStroke.id,
        payload: { x: 42 },
      }).success,
    ).toBe(true)
  })

  it('requires an empty payload on DELETE', () => {
    const base = {
      id: '44444444-4444-4444-8444-444444444444',
      type: 'DELETE' as const,
      objectId: validStroke.id,
    }
    expect(ClientOpSchema.safeParse({ ...base, payload: {} }).success).toBe(true)
    expect(ClientOpSchema.safeParse({ ...base, payload: { x: 1 } }).success).toBe(false)
  })

  it('requires op ids to be uuids — the idempotency key, R-SYNC-014', () => {
    expect(
      ClientOpSchema.safeParse({
        id: 'not-a-uuid',
        type: 'DELETE',
        objectId: validStroke.id,
        payload: {},
      }).success,
    ).toBe(false)
  })
})

describe('protocol — TRD §5.2', () => {
  it('validates a join message', () => {
    expect(
      ClientMessageSchema.safeParse({
        t: 'join',
        boardId: '55555555-5555-4555-8555-555555555555',
        sinceSeq: 0,
      }).success,
    ).toBe(true)
  })

  it('rejects a non-finite cursor coordinate', () => {
    expect(
      ClientMessageSchema.safeParse({ t: 'cursor', x: Infinity, y: 0 }).success,
    ).toBe(false)
  })

  it('validates a nack, which is never batched — R-SYNC-016', () => {
    expect(
      ServerMessageSchema.safeParse({
        t: 'nack',
        id: '66666666-6666-4666-8666-666666666666',
        code: 'FORBIDDEN',
        message: 'View-only access',
      }).success,
    ).toBe(true)
  })

  it('classifies presence vs ops correctly — R-SYNC-001', () => {
    for (const t of ['cursor', 'sel', 'stroke', 'xform'])
      expect(isPresenceMessage(t)).toBe(true)
    for (const t of ['op', 'op_batch', 'join']) expect(isPresenceMessage(t)).toBe(false)
  })
})

describe('auth schemas — FR-AUTH-001', () => {
  it('requires a letter and a number in the password', () => {
    const ok = { email: 'priya@example.com', password: 'goodpass1', displayName: 'Priya' }
    expect(RegisterSchema.safeParse(ok).success).toBe(true)
    expect(RegisterSchema.safeParse({ ...ok, password: 'allletters' }).success).toBe(
      false,
    )
    expect(RegisterSchema.safeParse({ ...ok, password: '12345678' }).success).toBe(false)
    expect(RegisterSchema.safeParse({ ...ok, password: 'short1' }).success).toBe(false)
  })

  it('trims the display name and rejects whitespace-only', () => {
    const parsed = RegisterSchema.safeParse({
      email: 'a@b.co',
      password: 'goodpass1',
      displayName: '  Marcus  ',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.displayName).toBe('Marcus')

    expect(
      RegisterSchema.safeParse({
        email: 'a@b.co',
        password: 'goodpass1',
        displayName: '   ',
      }).success,
    ).toBe(false)
  })
})

describe('frozen palettes — R-UI-013, R-UI-014', () => {
  it('has exactly 12 presence colours in the PRD §15 order', () => {
    expect(PRESENCE_COLOURS).toHaveLength(12)
    expect(PRESENCE_COLOURS[0]).toBe('#EF4444')
    expect(PRESENCE_COLOURS[11]).toBe('#F43F5E')
  })

  it('has exactly 8 sticky colours matching PRD §15', () => {
    expect(Object.keys(STICKY_COLOURS)).toHaveLength(8)
    expect(STICKY_COLOURS.yellow).toBe('#FEF08A')
    expect(STICKY_COLOURS.grey).toBe('#E4E4E7')
  })
})

describe('UPDATE payloads are strict — finding 1', () => {
  const op = (payload: unknown) => ({
    id: '55555555-5555-4555-8555-555555555555',
    type: 'UPDATE' as const,
    objectId: validStroke.id,
    payload,
  })

  it('refuses unknown keys, id, type, null and out-of-bounds values', () => {
    for (const payload of [
      { notAField: 1 },
      { id: validStroke.id },
      { type: 'image' },
      { points: null },
      { x: Infinity },
      { x: 2_000_000 },
      { width: 'abc' },
      { opacity: 2 },
    ]) {
      expect(ClientOpSchema.safeParse(op(payload)).success, JSON.stringify(payload)).toBe(
        false,
      )
    }
  })

  it('accepts a partial of any object type, including keys two types share', () => {
    for (const payload of [
      {},
      { x: 1, y: 2 },
      { color: '#123456' }, // a stroke or text colour
      { fontSize: 'auto' }, // a sticky's
      { text: 'x'.repeat(5_000) }, // a text object's maximum
      { url: 'https://cdn.example.com/a.png', cornerRadius: 4 },
    ]) {
      expect(
        UpdatePayloadSchema.safeParse(payload).success,
        JSON.stringify(payload),
      ).toBe(true)
    }
  })

  it('narrows to the exact type: a sticky accepts only its frozen palette', () => {
    expect(UpdatePayloadByType.sticky.safeParse({ color: '#FEF08A' }).success).toBe(true)
    expect(UpdatePayloadByType.sticky.safeParse({ color: '#123456' }).success).toBe(false)
    expect(
      UpdatePayloadByType.rect.safeParse({ url: 'https://x.example/a.png' }).success,
    ).toBe(false)
    expect(
      UpdatePayloadByType.sticky.safeParse({ text: 'x'.repeat(2_001) }).success,
    ).toBe(false)
  })

  it('stays equivalent to merge-and-reparse: no object schema has a cross-field rule', () => {
    // The server validates an UPDATE per field against the target's type
    // instead of materialising and re-parsing the merged object. That is
    // only sound while every object schema is a plain object — a refinement
    // across fields would wrap it in ZodEffects and fail here.
    expect(BoardObjectSchema).toBeInstanceOf(z.ZodDiscriminatedUnion)
    for (const option of BoardObjectSchema.options) {
      expect(option).toBeInstanceOf(z.ZodObject)
    }
  })

  it('bounds stroke points like every other coordinate', () => {
    expect(
      StrokeObjectSchema.safeParse({ ...validStroke, points: [0, 0, 0.5, 1e300, 1, 0.5] })
        .success,
    ).toBe(false)
  })
})

describe('CREATE rules — findings 1 and 7', () => {
  it('requires payload.id === objectId', () => {
    expect(
      ClientOpSchema.safeParse({
        id: '66666666-6666-4666-8666-666666666666',
        type: 'CREATE',
        objectId: '77777777-7777-4777-8777-777777777777',
        payload: validStroke,
      }).success,
    ).toBe(false)
  })

  it('caps the serialized payload at OP_PAYLOAD_MAX_BYTES', () => {
    const points = Array.from({ length: 30_000 }, (_, i) => 123_456.123456789 + i / 7)
    const big = { ...validStroke, points }
    expect(JSON.stringify(big).length).toBeGreaterThan(OP_PAYLOAD_MAX_BYTES)
    expect(
      ClientOpSchema.safeParse({
        id: '88888888-8888-4888-8888-888888888888',
        type: 'CREATE',
        objectId: validStroke.id,
        payload: big,
      }).success,
    ).toBe(false)
  })
})

describe('ServerOpSchema stays lenient on stored UPDATEs', () => {
  it('accepts a historical UPDATE the strict client schema would refuse', () => {
    // The client parses every op_batch with this; one old op must not make it
    // drop a whole batch and diverge.
    expect(
      ServerOpSchema.safeParse({
        id: '99999999-9999-4999-8999-999999999999',
        type: 'UPDATE',
        objectId: validStroke.id,
        payload: { legacyKey: true },
        seq: 4,
        actorSessionId: 'replay',
      }).success,
    ).toBe(true)
  })
})
