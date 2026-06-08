/**
 * Session CRUD endpoint schemas (REST.md §3.3).
 *
 * Exposes Zod schemas + TS types for the 5 endpoint payloads in REST §3.3:
 *
 *   POST    /v1/sessions               body: SessionCreate   data: Session
 *   GET     /v1/sessions               query: ListSessions   data: Page<Session>
 *   GET     /v1/sessions/{id}          -                     data: Session
 *   PATCH   /v1/sessions/{id}          body: SessionUpdate   data: Session
 *   DELETE  /v1/sessions/{id}          -                     data: { deleted: true }
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

// --- POST /v1/sessions/{id}/meta --------------------------------------------
// Per design principle: no PATCH on sessions; mutating properties go through
// an explicit action-suffix endpoint.

export const updateSessionMetaRequestSchema = sessionUpdateSchema;
export type UpdateSessionMetaRequest = z.infer<typeof updateSessionMetaRequestSchema>;

export const updateSessionMetaResponseSchema = sessionSchema;
export type UpdateSessionMetaResponse = z.infer<typeof updateSessionMetaResponseSchema>;

// --- (deprecated alias kept for gradual migration) PATCH /v1/sessions/{id} ----

export const updateSessionRequestSchema = sessionUpdateSchema;
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export const updateSessionResponseSchema = sessionSchema;
export type UpdateSessionResponse = z.infer<typeof updateSessionResponseSchema>;

// --- DELETE /v1/sessions/{id} -----------------------------------------------

export const deleteSessionResponseSchema = z.object({
  deleted: z.literal(true),
});
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>;
