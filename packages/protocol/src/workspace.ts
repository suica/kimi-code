/**
 * Workspace entity schemas.
 *
 * A Workspace is a lightweight pointer to a real folder on disk; the daemon
 * keeps a tiny metadata record per folder under
 * `<KIMI_CODE_HOME>/sessions/<wd-key>/workspace.json`, where `<wd-key>` is
 * agent-core's `encodeWorkDirKey(root)` output (`wd_<slug>_<sha256-12>`).
 * The id field reuses that wd-key verbatim so it round-trips cleanly between
 * the daemon's session store and the protocol surface, and so Session
 * responses can derive their `workspace_id` from the session's `workDir`
 * without any extra persistence.
 *
 * Wire shape: snake_case fields, ISO 8601 `Z`-suffix timestamps via
 * `isoDateTimeSchema`.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './time';

/**
 * `Workspace.id` shape. Mirrors agent-core's `encodeWorkDirKey` output:
 *   `wd_<slug>_<12 hex chars>`
 *
 * The slug is the lowercased / sanitised basename per
 * `slugifyWorkDirName` (lowercase letters, digits, dots, underscores,
 * dashes). Hash is exactly 12 lowercase hex chars.
 */
export const workspaceIdSchema = z
  .string()
  .regex(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/, {
    message: 'workspace_id must be a wd_<slug>_<hash12> string',
  });

export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

// --- Workspace (entity) -----------------------------------------------------

export const workspaceSchema = z.object({
  /** Stable id; reuses agent-core's `encodeWorkDirKey(root)`. */
  id: workspaceIdSchema,
  /** Absolute filesystem path of the workspace root (post-realpath). */
  root: z.string().min(1),
  /** Display name; defaults to `basename(root)`. */
  name: z.string().min(1).max(100),
  /** True when `<root>/.git` is present (dir or worktree file). */
  is_git_repo: z.boolean(),
  /** Current branch when `is_git_repo`; null when detached or unavailable. */
  branch: z.string().nullable(),
  /** Mint timestamp (first POST /workspaces for this root). */
  created_at: isoDateTimeSchema,
  /** Touched on every POST /workspaces for this root and on session create. */
  last_opened_at: isoDateTimeSchema,
  /** Count of `<wd-key>/<session_id>/` subdirectories in the session store. */
  session_count: z.number().int().nonnegative(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

// --- WorkspaceCreate / WorkspaceUpdate (subsets) ----------------------------

/**
 * `POST /v1/workspaces` request body. `root` must be absolute (daemon
 * `realpath`s it before computing the wd-key). `name` defaults to
 * `basename(realpath(root))` when omitted.
 */
export const workspaceCreateSchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
});

export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;

/**
 * `PATCH /v1/workspaces/{workspace_id}` request body. Only the display name
 * is mutable; the underlying `root` is immutable because it keys the wd-key.
 */
export const workspaceUpdateSchema = z.object({
  name: z.string().min(1).max(100),
});

export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;
