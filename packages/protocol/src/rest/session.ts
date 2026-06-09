/**
 * Session endpoint schemas (REST.md §3.3).
 *
 * Exposes Zod schemas + TS types for session endpoint payloads:
 *
 *   POST    /v1/sessions                  body: SessionCreate   data: Session
 *   GET     /v1/sessions                  query: ListSessions   data: Page<Session>
 *   GET     /v1/sessions/{id}             -                     data: Session
 *   GET     /v1/sessions/{id}/profile     -                     data: Session
 *   POST    /v1/sessions/{id}/profile     body: SessionUpdate   data: Session
 *   POST    /v1/sessions/{id}:fork        body: SessionFork     data: Session
 *   GET     /v1/sessions/{id}/status      -                     data: SessionStatus
 *   DELETE  /v1/sessions/{id}             -                     data: { deleted: true }
 *
 * Cursor pagination (REST §1.6 / SCHEMAS §1.3) is shared via
 * `cursorQuerySchema`; we extend it with an optional `status` filter per
 * REST §3.3 query string.
 *
 * Note: action-suffix endpoints (`POST /v1/sessions/{id}/prompts/{pid}:abort`,
 * `POST /v1/sessions/{id}/questions/{qid}:dismiss`) belong to later chains and
 * are NOT in this file.
 */

import { z } from 'zod';

import { cursorQuerySchema } from '../pagination';
import {
  sessionCreateSchema,
  sessionForkSchema,
  sessionSchema,
  sessionStatusSchema,
  sessionUpdateSchema,
} from '../session';

// --- POST /v1/sessions ------------------------------------------------------

export const createSessionRequestSchema = sessionCreateSchema;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionResponseSchema = sessionSchema;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

// --- GET /v1/sessions -------------------------------------------------------

/**
 * `GET /v1/sessions` query — cursor pagination + optional status filter.
 *
 * `before_id` / `after_id` are mutually exclusive (validated in
 * `cursorQuerySchema`). When `status` is supplied, daemon filters to that
 * single state.
 */
export const listSessionsQuerySchema = cursorQuerySchema.and(
  z.object({
    status: sessionStatusSchema.optional(),
  }),
);
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

// --- GET /v1/sessions/{id} --------------------------------------------------

export const getSessionResponseSchema = sessionSchema;
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;

// --- GET /v1/sessions/{id}/profile ----------------------------------------

export const getSessionProfileResponseSchema = sessionSchema;
export type GetSessionProfileResponse = z.infer<typeof getSessionProfileResponseSchema>;

// --- POST /v1/sessions/{id}/profile ---------------------------------------
// Per design principle: no PATCH on sessions; mutating properties go through
// an explicit action-suffix endpoint.

export const updateSessionProfileRequestSchema = sessionUpdateSchema;
export type UpdateSessionProfileRequest = z.infer<typeof updateSessionProfileRequestSchema>;

export const updateSessionProfileResponseSchema = sessionSchema;
export type UpdateSessionProfileResponse = z.infer<typeof updateSessionProfileResponseSchema>;

// --- Deprecated aliases ----------------------------------------------------

export const updateSessionMetaRequestSchema = updateSessionProfileRequestSchema;
export type UpdateSessionMetaRequest = UpdateSessionProfileRequest;

export const updateSessionMetaResponseSchema = updateSessionProfileResponseSchema;
export type UpdateSessionMetaResponse = UpdateSessionProfileResponse;

export const updateSessionRequestSchema = sessionUpdateSchema;
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export const updateSessionResponseSchema = sessionSchema;
export type UpdateSessionResponse = z.infer<typeof updateSessionResponseSchema>;

// --- POST /v1/sessions/{id}:fork ------------------------------------------

export const forkSessionRequestSchema = sessionForkSchema;
export type ForkSessionRequest = z.infer<typeof forkSessionRequestSchema>;

export const forkSessionResponseSchema = sessionSchema;
export type ForkSessionResponse = z.infer<typeof forkSessionResponseSchema>;

// --- GET /v1/sessions/{id}/status -----------------------------------------

export const sessionStatusResponseSchema = z.object({
  model: z.string().optional(),
  thinking_level: z.string(),
  permission: z.string(),
  plan_mode: z.boolean(),
  context_tokens: z.number().int().nonnegative(),
  max_context_tokens: z.number().int().nonnegative(),
  context_usage: z.number().min(0).max(1),
});
export type SessionStatusResponse = z.infer<typeof sessionStatusResponseSchema>;

// --- DELETE /v1/sessions/{id} -----------------------------------------------

export const deleteSessionResponseSchema = z.object({
  deleted: z.literal(true),
});
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>;
