/**
 * Prompt submission + lifecycle event payload schemas (SCHEMAS.md §5 / §3,
 * W7.2 / Chain 4).
 *
 * **Wire shapes** (REST.md §3.5):
 *
 *   POST /v1/sessions/{sid}/prompts
 *     Body:  PromptSubmission { content: MessageContent[], metadata?: ... }
 *     Reply: PromptSubmitResult { prompt_id, user_message_id }
 *
 *   POST /v1/sessions/{sid}/prompts/{pid}:abort
 *     Body:  empty
 *     Reply: { aborted: true, at_seq: number }   (envelope code 0)
 *            { aborted: false, at_seq: number }  (envelope code 40903, idempotent)
 *
 * **Synthesized lifecycle events** (W7 §critical discovery point #2):
 * agent-core's event union has no `prompt.completed` / `prompt.aborted`
 * types. The daemon synthesizes them at the IEventService layer when a
 * top-level `turn.ended` fires for a prompt — see
 * `packages/services/src/prompt/promptService.ts`. Wire types live
 * here so clients can parse them.
 */

import { z } from 'zod';

import { messageContentSchema } from '../message';

// --- SCHEMAS §5 PromptSubmission --------------------------------------------

/**
 * Request body for `POST /v1/sessions/{sid}/prompts`.
 *
 * `content` is at least one MessageContent part. SCHEMAS §3 documents
 * `text` / `tool_use` / `tool_result` / `image` / `file` / `thinking` as the
 * valid variants; in practice the SDK side only accepts `text` /
 * `image` / `file` content from clients today (`tool_*` and `thinking`
 * originate from the model).
 *
 * `metadata` is a free Record passed through to agent-core as the prompt's
 * origin metadata.
 */
export const promptSubmissionSchema = z.object({
  content: z.array(messageContentSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type PromptSubmission = z.infer<typeof promptSubmissionSchema>;

// --- SCHEMAS §5 PromptSubmitResult ------------------------------------------

export const promptSubmitResultSchema = z.object({
  prompt_id: z.string().min(1),
  user_message_id: z.string().min(1),
});
export type PromptSubmitResult = z.infer<typeof promptSubmitResultSchema>;

// --- Abort response shape ---------------------------------------------------

/**
 * Wire shape for `POST /v1/sessions/{sid}/prompts/{pid}:abort` envelope.data.
 * On envelope.code = 0 → `aborted: true`. On envelope.code = 40903
 * (idempotent) → `aborted: false`. `at_seq` is the per-session event
 * sequence number captured at abort time (informational; may help clients
 * line up their local view with what's already been delivered).
 */
export const promptAbortResponseSchema = z.object({
  aborted: z.boolean(),
  at_seq: z.number().int().nonnegative().optional(),
});
export type PromptAbortResponse = z.infer<typeof promptAbortResponseSchema>;

// --- Synthesized prompt lifecycle event payloads ----------------------------

/**
 * `event.prompt.completed` — synthesized by the daemon when a top-level
 * `turn.ended` event fires with `reason: 'completed'`. Mirrors WS.md §4.9's
 * prompt-completion semantics.
 *
 * `at_seq` is the sequence number of the original `turn.ended` event so
 * clients can correlate.
 */
export interface PromptCompletedEventPayload {
  readonly type: 'prompt.completed';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly finishedAt: string;
}

/**
 * `event.prompt.aborted` — synthesized by the daemon when a top-level
 * `turn.ended` event fires with `reason: 'cancelled'`, OR (when the model
 * never emits a turn.ended after cancel) directly upon a REST/WS abort call.
 */
export interface PromptAbortedEventPayload {
  readonly type: 'prompt.aborted';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly abortedAt: string;
}
