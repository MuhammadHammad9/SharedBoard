/**
 * @coboard/shared — the single source of truth for types, schemas, the socket
 * contract and pure geometry, imported by BOTH client and server.
 *
 * R-ARCH-007 (Blocking): duplicating a type across the boundary is forbidden.
 * That is how you end up with `strokeWidth` on one side and `stroke_width` on
 * the other, and lose a day to it.
 */

export * from './types/branded.js'
export * from './constants.js'
export * from './geometry.js'
export * from './errors.js'
export * from './protocol.js'
export * from './schemas/object.js'
export * from './schemas/op.js'
export * from './schemas/auth.js'
export * from './schemas/board.js'
