/**
 * Background Tasks REST endpoint schemas (REST.md §3.7).
 *
 * 3 endpoints:
 *
 *   GET  /v1/sessions/{session_id}/tasks                 query: {status?}
 *     Response data: `{ items: BackgroundTask[] }`
 *
 *   GET  /v1/sessions/{session_id}/tasks/{task_id}       query: {with_output?, output_bytes?}
 *     Response data: `BackgroundTask`
 *     Errors: 40406 (task.not_found)
 *
 *   POST /v1/sessions/{session_id}/tasks/{task_id}:cancel
 *     Body: empty
 *     Response data: `{ cancelled: true }`
 *     Errors: 40406 (task.not_found), 40904 (task.already_finished)
 *
 * Notes:
 *  - REST.md §3.7 "不分页 — 同 session 的活跃 + 历史任务总量 < 100".
 *    We accept no `before_id`/`after_id` cursor at the route layer.
 *  - `with_output=true` + `output_bytes=N` are documented but deferred —
 *    agent-core's `getBackground` shape does not surface output text inline.
 *    `output_bytes` defaults to 0 per spec; today we ignore the query.
 *  - The action-suffix `:cancel` uses the shared `parseActionSuffix` helper
 *    (the 5th call site, after prompts:abort, questions:resolve|dismiss,
 *    mcp:restart).
 */

import { z } from 'zod';

import { backgroundTaskSchema, backgroundTaskStatusSchema } from '../task';

// --- GET /v1/sessions/{sid}/tasks -------------------------------------------

export const listTasksQuerySchema = z.object({
  status: backgroundTaskStatusSchema.optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const listTasksResponseSchema = z.object({
  items: z.array(backgroundTaskSchema),
});
export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;

// --- GET /v1/sessions/{sid}/tasks/{tid} -------------------------------------

export const getTaskQuerySchema = z.object({
  with_output: z.coerce.boolean().optional(),
  output_bytes: z.coerce.number().int().nonnegative().optional(),
});
export type GetTaskQuery = z.infer<typeof getTaskQuerySchema>;

export const getTaskResponseSchema = backgroundTaskSchema;
export type GetTaskResponse = z.infer<typeof getTaskResponseSchema>;

// --- POST /v1/sessions/{sid}/tasks/{tid}:cancel -----------------------------

export const cancelTaskResultSchema = z.object({
  cancelled: z.literal(true),
});
export type CancelTaskResult = z.infer<typeof cancelTaskResultSchema>;

/**
 * Custom envelope data for `code: 40904 task.already_finished` (REST.md
 * §3.7 line 426). Same idempotent shape as 40903/40902.
 */
export const taskAlreadyFinishedDataSchema = z.object({
  cancelled: z.literal(false),
});
export type TaskAlreadyFinishedData = z.infer<typeof taskAlreadyFinishedDataSchema>;
