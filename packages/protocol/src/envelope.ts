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
 */
export const envelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    code: z.number().int(),
    msg: z.string(),
    data: data.nullable(),
    request_id: z.string(),
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
