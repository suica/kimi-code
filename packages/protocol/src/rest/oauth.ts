/**
 * OAuth device-code flow REST schemas (`/v1/oauth/login` + `/v1/oauth/logout`).
 *
 * Wire shapes (REST.md §6):
 *
 *   POST   /v1/oauth/login   body: { provider? }   data: OAuthFlowStart
 *   GET    /v1/oauth/login   query: { provider? }  data: OAuthFlowStatus | null
 *   DELETE /v1/oauth/login   query: { provider? }  data: { cancelled, status }
 *   POST   /v1/oauth/logout  body: { provider? }   data: { logged_out, provider }
 *
 * **Design notes**:
 *
 * - **One in-flight flow per provider**. The daemon keeps at most one pending
 *   flow per provider; the resource is implicit. The minted `flow_id` is
 *   returned so the client can detect
 *   "the flow I started got cancelled because a new one started elsewhere"
 *   (status='cancelled' with a different flow_id).
 *
 * - **`device_code` never crosses the wire**. It stays in the daemon's
 *   in-memory map alongside the flow state. The frontend uses
 *   `verification_uri_complete` + `user_code` to drive the user agent.
 *
 * - **Flow lifecycle decoupled from client**. The daemon does NOT detect
 *   frontend exit / WS disconnect / tab close. Cleanup is driven by:
 *   (1) upstream 15-min hard timeout, (2) explicit DELETE, (3) same-provider
 *   new flow superseding old. Completed flows live for 5 min so a slow poll
 *   catches the final status.
 */
import { z } from 'zod';

import { isoDateTimeSchema } from '../time';

/**
 * Lifecycle states for a device-code flow.
 *
 *   - `pending`       — daemon is polling the OAuth host
 *   - `authenticated` — token acquired + config provisioned
 *   - `denied`        — user explicitly rejected on the OAuth host
 *   - `expired`       — device_code TTL ran out (15 min budget) before approval
 *   - `cancelled`     — user hit DELETE, OR a new flow superseded this one
 */
export const oauthFlowStatusEnum = z.enum([
  'pending',
  'authenticated',
  'denied',
  'expired',
  'cancelled',
]);
export type OAuthFlowStatus = z.infer<typeof oauthFlowStatusEnum>;

// --- POST /v1/oauth/login ---------------------------------------------------

export const oauthLoginStartRequestSchema = z.object({
  /** Provider name; defaults to `'managed:kimi-code'`. */
  provider: z.string().min(1).optional(),
});
export type OAuthLoginStartRequest = z.infer<typeof oauthLoginStartRequestSchema>;

/**
 * Response from `POST /v1/oauth/login`. Carries everything the frontend needs
 * to drive the user-agent (browser) — but NOT `device_code`.
 */
export const oauthFlowStartSchema = z.object({
  flow_id: z.string().min(1),
  provider: z.string().min(1),
  verification_uri: z.string().url(),
  /** URL with `user_code` pre-filled. Recommended UX target (QR / new tab). */
  verification_uri_complete: z.string().url(),
  /** Human-readable code the user types if they used `verification_uri`. */
  user_code: z.string().min(1),
  /** Wall-clock TTL of the device_code in seconds. */
  expires_in: z.number().int().positive(),
  /** Minimum poll interval the OAuth host requests (seconds). */
  interval: z.number().int().positive(),
  status: z.literal('pending'),
  /** ISO 8601 deadline computed from `expires_in` + boot time. */
  expires_at: isoDateTimeSchema,
});
export type OAuthFlowStart = z.infer<typeof oauthFlowStartSchema>;

// --- GET /v1/oauth/login ----------------------------------------------------

/**
 * `GET /v1/oauth/login` response — current flow state (or `null` if no flow
 * has ever been started for this provider in this daemon process).
 *
 * After a flow reaches a terminal state (`authenticated` / `denied` /
 * `expired` / `cancelled`), it stays accessible for 5 min so the frontend's
 * last poll lands on the final status. After 5 min, GC drops it and this
 * endpoint returns `null` again.
 */
export const oauthFlowSnapshotSchema = z.object({
  flow_id: z.string().min(1),
  provider: z.string().min(1),
  status: oauthFlowStatusEnum,
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  user_code: z.string().min(1),
  expires_in: z.number().int().positive(),
  expires_at: isoDateTimeSchema,
  interval: z.number().int().positive(),
  /** Set when `status !== 'pending'`. ISO 8601 of the transition. */
  resolved_at: isoDateTimeSchema.optional(),
  /** Human-readable error message for terminal-failure states. */
  error_message: z.string().optional(),
});
export type OAuthFlowSnapshot = z.infer<typeof oauthFlowSnapshotSchema>;

export const oauthLoginQuerySchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLoginQuery = z.infer<typeof oauthLoginQuerySchema>;

// --- DELETE /v1/oauth/login -------------------------------------------------

/**
 * `DELETE /v1/oauth/login` response. Idempotent — cancelling a non-pending
 * flow returns `{cancelled: false, status: <現状>}` instead of erroring.
 */
export const oauthLoginCancelResponseSchema = z.object({
  cancelled: z.boolean(),
  status: oauthFlowStatusEnum,
});
export type OAuthLoginCancelResponse = z.infer<typeof oauthLoginCancelResponseSchema>;

// --- POST /v1/oauth/logout --------------------------------------------------

export const oauthLogoutRequestSchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLogoutRequest = z.infer<typeof oauthLogoutRequestSchema>;

export const oauthLogoutResponseSchema = z.object({
  logged_out: z.literal(true),
  provider: z.string().min(1),
});
export type OAuthLogoutResponse = z.infer<typeof oauthLogoutResponseSchema>;
