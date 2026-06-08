/**
 * Daemon-level filesystem browser endpoint schemas (non-session-scoped).
 *
 *   GET /v1/fs:browse?path=<abs-path>
 *     Lists immediate subdirectories of `path` (file entries are NOT
 *     returned — this endpoint backs the "Add workspace" folder picker).
 *     `path` defaults to `$HOME` when omitted. Must be an absolute path.
 *
 *   GET /v1/fs:home
 *     Returns the user's home directory + a small list of recently used
 *     workspace roots (derived from the registered workspaces list).
 *
 * Errors:
 *   - 40001 validation.failed       (path is not absolute)
 *   - 40409 fs.path_not_found       (ENOENT / ENOTDIR)
 *   - 40411 fs.permission_denied    (EACCES)
 */

import { z } from 'zod';

// --- GET /v1/fs:browse ------------------------------------------------------

export const fsBrowseQuerySchema = z.object({
  /** Absolute path; defaults to `$HOME` when omitted. */
  path: z.string().min(1).optional(),
});
export type FsBrowseQuery = z.infer<typeof fsBrowseQuerySchema>;

/**
 * Single entry returned by `fs:browse`. Only directories are surfaced — the
 * picker doesn't need files. `is_dir` is `true` so the shape stays open for
 * future extensions (e.g. file picker mode) without a breaking change.
 */
export const fsBrowseEntrySchema = z.object({
  /** Basename of the directory (e.g. `kimi-code`). */
  name: z.string().min(1),
  /** Absolute, realpath-resolved path. */
  path: z.string().min(1),
  /** Always `true` in the current shape (directories only). */
  is_dir: z.literal(true),
  /** True when `<path>/.git` exists (dir or worktree file). */
  is_git_repo: z.boolean(),
  /** Current branch when `is_git_repo`; absent when detached / unavailable. */
  branch: z.string().optional(),
});
export type FsBrowseEntry = z.infer<typeof fsBrowseEntrySchema>;

export const fsBrowseResponseSchema = z.object({
  /** Realpath-resolved version of the requested `path`. */
  path: z.string().min(1),
  /** Parent directory; null when `path` is a filesystem root. */
  parent: z.string().min(1).nullable(),
  /** Immediate subdirectories of `path`. */
  entries: z.array(fsBrowseEntrySchema),
});
export type FsBrowseResponse = z.infer<typeof fsBrowseResponseSchema>;

// --- GET /v1/fs:home --------------------------------------------------------

export const fsHomeResponseSchema = z.object({
  /** User's home directory; the natural starting point of the picker. */
  home: z.string().min(1),
  /** Up to 8 recently-opened workspace roots, newest first. */
  recent_roots: z.array(z.string().min(1)),
});
export type FsHomeResponse = z.infer<typeof fsHomeResponseSchema>;
