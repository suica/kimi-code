/**
 * Session entity schemas (SCHEMAS.md §2 / §2.1 / §2.2).
 *
 * Wire shape: snake_case fields, ISO 8601 `Z`-suffix timestamps via
 * `isoDateTimeSchema`. Daemon emits Session via `okEnvelope(session, req.id)`;
 * clients parse via `sessionSchema`.
 *
 * Agent-core's `SessionSummary` / `SessionMeta` are camelCase + number/string
 * timestamps; the cross-package adapter lives in
 * `packages/services/src/impls/session-service-impl.ts` (`toProtocolSession`).
 *
 * Coverage gaps pending agent-core surface work:
 *   - `status`: agent-core does not expose a session "status" enum yet; the
 *     adapter returns 'idle' for now. Will be promoted to a real signal once
 *     the bridge surfaces `event.session.status`.
 *   - `usage`: cumulative `SessionUsage` is not exposed by CoreAPI today;
 *     daemon returns the zero usage struct.
 *   - `permission_rules`: PermissionRule schema is defined here (and the
 *     daemon accepts updates to it), but the adapter currently echoes back
 *     an empty array — there is no CoreAPI surface to enumerate them.
 *   - `message_count` / `last_seq`: not yet surfaced — defaulted to 0.
 *   - `agent_config`: surfaced from `CreateSessionPayload` echoes during
 *     `create`, but `get/list` re-derive from the limited CoreAPI surface;
 *     defaults applied as documented in the adapter.
 *
 * These are NOT silent omissions: the shape stays on-wire stable; the daemon
 * fills with empty/zero defaults until agent-core surfaces grow.
 */

import { z } from 'zod';

import {
  promptPermissionModeSchema,
  promptThinkingSchema,
} from './rest/prompt';
import { isoDateTimeSchema } from './time';
import { workspaceIdSchema } from './workspace';

// --- 2.x SessionStatus ------------------------------------------------------

export const sessionStatusSchema = z.enum([
  'idle',
  'running',
  'awaiting_approval',
  'awaiting_question',
  'aborted',
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

// --- 2.1 SessionUsage -------------------------------------------------------

export const sessionUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(),
  context_tokens: z.number().int().nonnegative(),
  context_limit: z.number().int().nonnegative(),
  turn_count: z.number().int().nonnegative(),
});

export type SessionUsage = z.infer<typeof sessionUsageSchema>;

/** Zero-initialized usage — used as default when daemon can't source counts. */
export function emptySessionUsage(): SessionUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  };
}

// --- 2.2 PermissionRule -----------------------------------------------------

export const permissionRuleMatcherSchema = z.object({
  kind: z.enum(['command_prefix', 'path_glob', 'exact_input', 'always']),
  value: z.string().optional(),
});

export const permissionRuleSchema = z.object({
  id: z.string().min(1),
  tool_name: z.string().min(1),
  matcher: permissionRuleMatcherSchema.optional(),
  decision: z.literal('approved'),
  created_at: isoDateTimeSchema,
  created_by: z.enum(['user', 'agent']),
});

export type PermissionRule = z.infer<typeof permissionRuleSchema>;

// --- 2 Session.agent_config -------------------------------------------------

export const sessionAgentConfigSchema = z.object({
  // SCHEMAS.md §2 documents `model` as required (e.g. "moonshot-v1-128k").
  // Allow empty string at parse time: agent-core's `listSessions` does NOT
  // surface the per-session model, so the daemon returns "" until the gap
  // closes (for example via `bridge.rpc.getModel({sessionId, agentId: 'main'})`).
  // The wire shape stays the same — clients should treat "" as "unknown".
  model: z.string(),
  system_prompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(),
  // Runtime controls. Optional on the READ side because the daemon's
  // `toProtocolSession` adapter doesn't backfill them (CoreAPI doesn't
  // expose them on the list path) — callers wanting the live values use
  // `GET /v1/sessions/{sid}/status`. Optional on the WRITE side
  // (`.partial()` → `sessionAgentConfigPartialSchema`) so `POST
  // /v1/sessions/{sid}/meta` can supply any subset to dispatch the
  // matching `setThinking` / `setPermission` / `enterPlan|cancelPlan` RPCs
  // through `IPromptService.applyAgentState`. The enum literals are
  // shared with `promptSubmissionSchema` so prompt-body overrides and
  // /meta updates speak the same vocabulary.
  thinking: promptThinkingSchema.optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
});

export type SessionAgentConfig = z.infer<typeof sessionAgentConfigSchema>;

export const sessionAgentConfigPartialSchema = sessionAgentConfigSchema.partial();
export type SessionAgentConfigPartial = z.infer<typeof sessionAgentConfigPartialSchema>;

// --- 2 Session.metadata -----------------------------------------------------

/**
 * `Session.metadata` — `cwd` is canonical (the session's working directory);
 * other keys are arbitrary JSON extensions.
 */
export const sessionMetadataSchema = z
  .object({
    cwd: z.string().min(1),
  })
  .catchall(z.unknown());

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

// --- 2 Session --------------------------------------------------------------

export const sessionSchema = z.object({
  id: z.string().min(1),
  /**
   * Workspace this session belongs to. Always derived from
   * `encodeWorkDirKey(summary.workDir)`, so every session has one; if the
   * caller never registered a workspace for that root the id will simply
   * not appear in `GET /workspaces` (front-end can group such sessions under
   * an "unregistered" bucket).
   */
  workspace_id: workspaceIdSchema,
  title: z.string(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  status: sessionStatusSchema,
  current_prompt_id: z.string().min(1).optional(),
  metadata: sessionMetadataSchema,
  agent_config: sessionAgentConfigSchema,
  usage: sessionUsageSchema,
  permission_rules: z.array(permissionRuleSchema),
  message_count: z.number().int().nonnegative(),
  last_seq: z.number().int().nonnegative(),
});

export type Session = z.infer<typeof sessionSchema>;

// --- SessionCreate / SessionUpdate (SCHEMAS §2 subsets) ---------------------

/**
 * `POST /v1/sessions` request body (SCHEMAS.md §2 `SessionCreate`).
 *
 * Either `workspace_id` or `metadata.cwd` must be supplied (caller picks):
 *
 *   - `workspace_id` (preferred): daemon route layer resolves the workspace
 *     root via the workspace registry and feeds it as `metadata.cwd` to
 *     agent-core's `createSession`.
 *   - `metadata.cwd` (legacy / direct): caller passes the absolute cwd
 *     verbatim; no workspace association is created.
 *
 * If BOTH are supplied they must agree on the same root, otherwise the
 * daemon returns `40001 validation.failed` from the route layer. The wire
 * schema accepts either ordering; the at-least-one check happens at the
 * route layer (we don't superRefine in the protocol because daemon-side
 * needs to surface the dedicated validation error code).
 */
export const sessionCreateSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: sessionMetadataSchema.optional(),
  agent_config: sessionAgentConfigPartialSchema.optional(),
  workspace_id: workspaceIdSchema.optional(),
});

export type SessionCreate = z.infer<typeof sessionCreateSchema>;

/**
 * `PATCH /v1/sessions/{session_id}` request body (SCHEMAS.md §2 `SessionUpdate`).
 *
 * Per SCHEMAS, `permission_rules` is a full replacement (empty array =
 * clear all session-runtime always-approve rules).
 */
export const sessionUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: sessionMetadataSchema.partial().optional(),
  agent_config: sessionAgentConfigPartialSchema.optional(),
  permission_rules: z.array(permissionRuleSchema).optional(),
});

export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;
