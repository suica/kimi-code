/**
 * Background Task entity schemas (SCHEMAS.md §7).
 *
 * Wire shape: snake_case fields; ISO 8601 `Z`-suffix timestamps via
 * `isoDateTimeSchema`. SCHEMAS §7 specifies these fields:
 *
 *   id                  string (ULID-like, stable per task)
 *   session_id          string
 *   kind                'subagent' | 'bash' | 'tool'
 *   description         string
 *   status              'running' | 'completed' | 'failed' | 'cancelled'
 *   created_at          ISO ts
 *   started_at?         ISO ts
 *   completed_at?       ISO ts
 *   output_preview?     string  (first N lines)
 *   output_bytes?       number
 *
 * Agent-core's `BackgroundTaskInfo` is a discriminated union over `kind`:
 *   - 'process' (ProcessBackgroundTask: bash command)
 *   - 'agent'   (AgentBackgroundTask: subagent)
 *   - 'question' (QuestionBackgroundTask: tool-spawned questioning)
 *
 * Plus a richer status enum:
 *   - 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost'
 *
 * Adapter (`packages/services/src/adapter/task-adapter.ts`) maps:
 *
 *   kind:
 *     agent-core 'process'   → wire 'bash'
 *     agent-core 'agent'     → wire 'subagent'
 *     agent-core 'question'  → wire 'tool'   (Question background task is a
 *                                             tool-driven flow; SCHEMAS §7
 *                                             has no 'question' literal so
 *                                             we collapse into 'tool')
 *
 *   status:
 *     agent-core 'running'    → wire 'running'
 *     agent-core 'completed'  → wire 'completed'
 *     agent-core 'failed'     → wire 'failed'
 *     agent-core 'timed_out'  → wire 'failed'    (lossy — last_error/stopReason
 *                                                 carries the timeout signal)
 *     agent-core 'killed'     → wire 'cancelled'
 *     agent-core 'lost'       → wire 'failed'    (lossy)
 *
 *   timestamps (agent-core uses `startedAt: number` ms + `endedAt: number|null`):
 *     `created_at` = `new Date(startedAt).toISOString()` (gap: agent-core has
 *        no separate creation-time stamp; we synthesize from `startedAt`)
 *     `started_at` = same as `created_at`
 *     `completed_at` = `endedAt !== null ? new Date(endedAt).toISOString() : undef`
 *
 *   `id` = agent-core `taskId`. Same value, just renamed.
 *
 *   `output_preview` / `output_bytes` are NOT yet surfaced via `getBackground`
 *     (the BackgroundTaskInfoBase shape has no output fields; output is
 *     fetched separately via `getBackgroundOutput`). Adapter omits both
 *     for now. REST.md §3.7 `with_output=true` query is documented but
 *     deferred until output fetching is wired through the adapter.
 *
 * **Anti-corruption**: this file imports zero `@moonshot-ai/agent-core` types.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './time';

// --- 7 TaskKind -------------------------------------------------------------

export const backgroundTaskKindSchema = z.enum(['subagent', 'bash', 'tool']);
export type BackgroundTaskKind = z.infer<typeof backgroundTaskKindSchema>;

// --- 7 TaskStatus -----------------------------------------------------------

export const backgroundTaskStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type BackgroundTaskStatus = z.infer<typeof backgroundTaskStatusSchema>;

// --- 7 BackgroundTask -------------------------------------------------------

export const backgroundTaskSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  kind: backgroundTaskKindSchema,
  description: z.string(),
  status: backgroundTaskStatusSchema,
  created_at: isoDateTimeSchema,
  started_at: isoDateTimeSchema.optional(),
  completed_at: isoDateTimeSchema.optional(),
  /**
   * SCHEMAS §7 "前 N 行预览". Optional because agent-core's `BackgroundTaskInfo`
   * doesn't include output today — we fetch it lazily via `getBackgroundOutput`.
   * Adapter omits until that wiring lands.
   */
  output_preview: z.string().optional(),
  output_bytes: z.number().int().nonnegative().optional(),
});
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;
