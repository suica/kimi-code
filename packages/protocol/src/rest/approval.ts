/**
 * Approval REST endpoint schemas (REST.md §3.6).
 *
 *   POST /v1/sessions/{session_id}/approvals/{approval_id}
 *     Body:  ApprovalResponse (decision + optional scope/feedback/selected_label)
 *     Reply: ApprovalResolveResult { resolved: true, resolved_at }
 *
 * **Error codes** (REST.md §3.6):
 *   - 40001 (validation.failed)
 *   - 40404 (approval.not_found)
 *   - 40902 (approval.already_resolved)        — custom envelope w/ data:{resolved:false}
 *   - 41001 (approval.expired)
 *
 * Side effect: broadcast `event.approval.resolved` to all subscribers
 * (WS.md §4.5). The agent's pending Promise resolves with the in-process
 * `ApprovalResponse` equivalent and the prompt continues.
 *
 * **Idempotency** (REST.md §3.6): a second resolve on the same approval_id
 * returns envelope `code: 40902` with `data.resolved: false` rather than a
 * bare error envelope. This matches the `:abort` idempotency shape
 * (`code: 40903 + data.aborted: false`) so clients can dispatch on `code` and
 * read the same `data` shape regardless.
 */

import { z } from 'zod';

import { approvalResponseSchema } from '../approval';
import { isoDateTimeSchema } from '../time';

// --- POST /v1/sessions/{sid}/approvals/{aid} --------------------------------

export const approvalResolveRequestSchema = approvalResponseSchema;
export type ApprovalResolveRequest = z.infer<typeof approvalResolveRequestSchema>;

export const approvalResolveResultSchema = z.object({
  resolved: z.literal(true),
  resolved_at: isoDateTimeSchema,
});
export type ApprovalResolveResult = z.infer<typeof approvalResolveResultSchema>;

/**
 * Custom envelope `data` for `code: 40902` idempotent re-resolve.
 *
 * REST.md §3.6 also mandates `details.resolved_by` carrying the original
 * resolver's client_id — this is a daemon-side concern and lives on the
 * envelope `details` field, not in `data`. Here we only schema the `data`
 * shape so clients can rely on it.
 */
export const approvalAlreadyResolvedDataSchema = z.object({
  resolved: z.literal(false),
});
export type ApprovalAlreadyResolvedData = z.infer<typeof approvalAlreadyResolvedDataSchema>;
