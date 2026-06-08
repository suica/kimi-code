/**
 * Messages history endpoint schemas (REST.md §3.4).
 *
 * 2 endpoints (REST.md §3.4):
 *
 *   GET /v1/sessions/{session_id}/messages
 *     Query: cursorQuery + role
 *     Default page_size=50; max 100 (per SCHEMAS §1.3).
 *     Response data: Page<Message>
 *
 *   GET /v1/sessions/{session_id}/messages/{message_id}
 *     Response data: Message
 *     Errors: 40401 (session.not_found) + 40403 (message.not_found)
 *
 * Cursor pagination is shared via `cursorQuerySchema`. Role filter is added
 * here per REST §3.4 query string.
 *
 * Default page_size = 50 per SCHEMAS §1.3 + REST.md §3.4 ("缺省 50") — applied
 * at the route layer (NOT here, mirrors session pagination's split).
 */

import { z } from 'zod';

import { messageRoleSchema, messageSchema } from '../message';
import { cursorQuerySchema } from '../pagination';

// --- GET /v1/sessions/{session_id}/messages ---------------------------------

/**
 * `GET /v1/sessions/{session_id}/messages` query.
 *
 * `before_id` / `after_id` are mutually exclusive (validated in
 * `cursorQuerySchema`). Optional `role` filter restricts the page to one
 * role; absent = all roles.
 */
export const listMessagesQuerySchema = cursorQuerySchema.and(
  z.object({
    role: messageRoleSchema.optional(),
  }),
);
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const listMessagesResponseSchema = z.object({
  items: z.array(messageSchema),
  has_more: z.boolean(),
});
export type ListMessagesResponse = z.infer<typeof listMessagesResponseSchema>;

// --- GET /v1/sessions/{session_id}/messages/{message_id} --------------------

export const getMessageResponseSchema = messageSchema;
export type GetMessageResponse = z.infer<typeof getMessageResponseSchema>;
