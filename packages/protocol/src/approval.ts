/**
 * Approval entity schemas (SCHEMAS.md §6.1).
 *
 * Approval is the **reverse-RPC** primitive — the daemon (via agent-core)
 * asks the user "may I run this tool?" and waits for a decision. The request
 * is broadcast over WS (`event.approval.requested`); the answer comes back
 * via `POST /v1/sessions/{sid}/approvals/{aid}`.
 *
 * **Wire vs in-process shape** (SCHEMAS.md §6.4): agent-core's in-process
 * `ApprovalRequest` (`packages/agent-core/src/rpc/sdk-api.ts:17-23`) is
 * camelCase and has no daemon-allocated id / expiry. SCHEMAS.md §6.1 adds:
 *   - `approval_id` (daemon-minted ULID; REST path parameter)
 *   - `session_id`
 *   - `tool_call_id` (snake_case of `toolCallId`)
 *   - `expires_at` / `created_at`
 *
 * The `tool_input_display` (snake_case of `display`) field is the
 * **12-arm ToolInputDisplay discriminated union** re-exported in
 * `./display.ts`. SCHEMAS.md §6.1 forbids carving a daemon-specific subset
 * — clients that don't understand a kind fall back to rendering
 * `generic.summary` ("未知字段宽松"). We therefore validate `tool_input_display`
 * as `z.unknown()` here (preserve wire shape, trust agent-core to produce a
 * valid 12-arm value); typed surface is the `ToolInputDisplay` re-export.
 *
 * **Response** (SCHEMAS.md §6.1): `decision` (approved / rejected / cancelled)
 * + optional `scope` (`'session'` = "approve_always", daemon-side runtime
 * rule), `feedback` (rejection rationale fed back to the agent), and
 * `selected_label` (only when `display.kind` carries `options[]`, e.g.
 * `plan_review`).
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './time';

// --- §6.1 ApprovalDecision / ApprovalScope ----------------------------------

/** Per SCHEMAS.md §6.1 — three terminal decisions, no `'expired'` here (that's encoded via `code: 41001` at the envelope layer). */
export const approvalDecisionSchema = z.enum(['approved', 'rejected', 'cancelled']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** Only `'session'` for now ("approve_always" runtime rule). Reserved for `'workspace'` etc. */
export const approvalScopeSchema = z.enum(['session']);
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

// --- §6.1 ApprovalRequest ---------------------------------------------------

/**
 * Approval request payload.
 *
 * Sent by daemon → client (WS event.approval.requested). The `approval_id` is
 * the correlation key — clients echo it on the REST response path.
 *
 * `tool_input_display` is `z.unknown()` rather than a structural schema:
 *   - SCHEMAS.md §6.1 mandates 12-arm passthrough with forward-compat fall-back
 *     (`generic.summary` rendering for unknown kinds).
 *   - Re-validating the union here would either drop kinds the protocol layer
 *     doesn't know about (breaking the fall-back contract) or duplicate the
 *     SDK Zod which is the SOT.
 *   - The TypeScript `ToolInputDisplay` re-export in `./display.ts` is the
 *     static surface; runtime wire validation is by-pass.
 */
export const approvalRequestSchema = z.object({
  approval_id: z.string().min(1),
  session_id: z.string().min(1),
  turn_id: z.number().int().nonnegative().optional(),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  action: z.string(),
  tool_input_display: z.unknown(),
  created_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema,
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

// --- §6.1 ApprovalResponse --------------------------------------------------

/**
 * Approval response payload (REST request body).
 *
 * `selected_label` is only populated when `display.kind` carries `options[]`
 * (e.g. `plan_review`). The route handler doesn't structurally validate the
 * option membership here (the display is `unknown` at this layer); daemon-
 * level checks live in the broker / route once the protocol→in-process
 * adapter has the original request handy.
 */
export const approvalResponseSchema = z.object({
  decision: approvalDecisionSchema,
  scope: approvalScopeSchema.optional(),
  feedback: z.string().optional(),
  selected_label: z.string().optional(),
});
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
