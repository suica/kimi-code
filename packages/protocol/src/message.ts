/**
 * Message entity schema (SCHEMAS.md §3).
 *
 * Wire shape: snake_case fields, ISO 8601 `Z`-suffix timestamps, IDs are ULIDs
 * (time-sortable, supports `before_id` / `after_id` cursor pagination per
 * SCHEMAS §1.3 + REST §1.6).
 *
 * SCHEMAS.md §3 defines `Message` as a single shape (NOT a per-role
 * discriminated union) with a `MessageContent[]` body that IS a discriminated
 * union (text / tool_use / tool_result / image / file / thinking).
 *
 *   type MessageRole = 'user' | 'assistant' | 'tool' | 'system';
 *
 *   interface Message {
 *     id: string;                      // ULID
 *     session_id: string;
 *     role: MessageRole;
 *     content: MessageContent[];
 *     created_at: IsoDateTime;
 *     prompt_id?: string;
 *     parent_message_id?: string;
 *     metadata?: Record<string, unknown>;
 *   }
 *
 * **agent-core mapping** — agent-core exposes a message history shape via
 * `getContext({sessionId}).history`, which is a
 * `readonly ContextMessage[]`. Each `ContextMessage` extends kosong's `Message`:
 *   - `role: 'system' | 'user' | 'assistant' | 'tool'`  (← maps 1:1)
 *   - `content: ContentPart[]` where `ContentPart` is
 *     `text | think | image_url | audio_url | video_url`
 *   - `toolCalls: ToolCall[]` (assistant only) — translated to `tool_use`
 *     content parts.
 *   - `toolCallId?: string` (tool role only) — translated to a `tool_result`
 *     content part wrapping the tool message's plain text.
 *
 * The mapping is lossy in two known ways and a SCHEMAS-allowed direction is
 * picked (`audio_url` is folded into `text` because SCHEMAS §3 doesn't have an
 * audio content variant; `partial` is dropped). Documented further in the
 * adapter (`packages/services/src/impls/message-service-impl.ts`).
 *
 * **ID synthesis** — kosong's `Message` has no `id` field. The daemon's
 * adapter mints a deterministic ULID-shaped id from the message's
 * (session_id, history_index) so list/get share a stable surface. See
 * `MessageServiceImpl.deriveMessageId`.
 *
 * **Timestamps** — kosong's `Message` has no `created_at` either. We derive
 * `created_at` from the session's `createdAt` + the history index (1ms per
 * message) so id ordering stays monotonic with `created_at`. Real timestamps
 * are punted until agent-core surfaces per-message persistence.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './time';

// --- §3 MessageRole ---------------------------------------------------------

export const messageRoleSchema = z.enum(['user', 'assistant', 'tool', 'system']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

// --- §3 MessageContent variants (discriminated union) -----------------------

export const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextContent = z.infer<typeof textContentSchema>;

export const toolUseContentSchema = z.object({
  type: z.literal('tool_use'),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  input: z.unknown(),
});
export type ToolUseContent = z.infer<typeof toolUseContentSchema>;

export const toolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  tool_call_id: z.string().min(1),
  output: z.unknown(),
  is_error: z.boolean().optional(),
});
export type ToolResultContent = z.infer<typeof toolResultContentSchema>;

/**
 * `image` source per SCHEMAS §3 — one of `url` / `base64` / `file` shapes.
 * Today the adapter only emits the `url` variant (kosong's `image_url` part);
 * `base64` and `file` are wire-stable for future expansion.
 */
export const imageSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().min(1) }),
  z.object({
    kind: z.literal('base64'),
    media_type: z.string().min(1),
    data: z.string().min(1),
  }),
  z.object({ kind: z.literal('file'), file_id: z.string().min(1) }),
]);
export type ImageSource = z.infer<typeof imageSourceSchema>;

export const imageContentSchema = z.object({
  type: z.literal('image'),
  source: imageSourceSchema,
});
export type ImageContent = z.infer<typeof imageContentSchema>;

export const fileContentSchema = z.object({
  type: z.literal('file'),
  file_id: z.string().min(1),
  name: z.string(),
  media_type: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type FileContent = z.infer<typeof fileContentSchema>;

export const thinkingContentSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
});
export type ThinkingContent = z.infer<typeof thinkingContentSchema>;

export const messageContentSchema = z.discriminatedUnion('type', [
  textContentSchema,
  toolUseContentSchema,
  toolResultContentSchema,
  imageContentSchema,
  fileContentSchema,
  thinkingContentSchema,
]);
export type MessageContent = z.infer<typeof messageContentSchema>;

// --- §3 Message -------------------------------------------------------------

export const messageSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  role: messageRoleSchema,
  content: z.array(messageContentSchema),
  created_at: isoDateTimeSchema,
  prompt_id: z.string().min(1).optional(),
  parent_message_id: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Message = z.infer<typeof messageSchema>;
