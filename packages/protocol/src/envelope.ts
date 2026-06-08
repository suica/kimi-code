/**
 * Feishu-style REST response envelope (SCHEMAS.md §1.1).
 *
 * All REST responses share this wire shape — HTTP status is always 200; the
 * business outcome lives in the `code` field. Wire shape must round-trip
 * byte-identical to the daemon's envelope re-export so JSON serialization is
 * stable across package boundaries.
 */
import { z } from 'zod';

/**
 * Runtime Zod schema for the envelope. Use as `envelopeSchema(z.object({...}))`
 * to parameterize over the `data` payload type.
 *
 * Note: `data` is nullable because error envelopes always set `data: null`
 * (SCHEMAS.md §1.1 "EnvelopeErr").
 *
 * `details` is an optional structured carrier for error contexts (REST.md
 * §1.4). On `40001 validation.failed` it's the `Array<{path, message}>`
 * shape; on other error codes (`40111`, `40113`, ...) it's a
 * code-specific record. Declared here so Fastify's response serializer
 * (`fast-json-stringify`) preserves the field — without it the serializer
 * silently strips `details` from every error envelope.
 */
export const envelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    code: z.number().int(),
    msg: z.string(),
    data: data.nullable(),
    request_id: z.string(),
    details: z.unknown().optional(),
  });

/**
 * Static type companion to `envelopeSchema`. `T` is the shape of `data` on
 * success; on failure `data` is `null`.
 */
export interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
}

/**
 * Build a success envelope. `code: 0`, `msg: 'success'`. The wire field order
 * matches the daemon's existing helper so JSON serialization is identical.
 */
export function okEnvelope<T>(data: T, requestId: string): Envelope<T> {
  return { code: 0, msg: 'success', data, request_id: requestId };
}

/**
 * Build an error envelope. `data` is fixed to `null` so the shape stays
 * stable across success and failure.
 */
export function errEnvelope(code: number, msg: string, requestId: string): Envelope<null> {
  return { code, msg, data: null, request_id: requestId };
}
