/**
 * Filesystem REST endpoint schemas (REST.md §3.9).
 *
 * Single-file endpoints:
 *
 *   POST /v1/sessions/{sid}/fs:list
 *     Body: FsListRequest
 *     Response data: FsListResponse  { items, children_by_path?, truncated }
 *     Errors: 40401, 40409, 41304, 41303
 *
 *   POST /v1/sessions/{sid}/fs:read
 *     Body: FsReadRequest
 *     Response data: FsReadResponse
 *     Errors: 40401, 40409, 40906, 40907, 41302, 41304
 *
 * Batch endpoints:
 *
 *   POST /v1/sessions/{sid}/fs:list_many
 *     Body: FsListManyRequest  (paths[] up to 100)
 *     Response data: FsListManyResponse  { results, truncated_paths?,
 *                                          partial_errors? }
 *
 *   POST /v1/sessions/{sid}/fs:stat
 *     Body: FsStatRequest
 *     Response data: FsEntry
 *     Errors: 40401, 40409, 41304
 *
 *   POST /v1/sessions/{sid}/fs:stat_many
 *     Body: FsStatManyRequest  (paths[] up to 1000)
 *     Response data: FsStatManyResponse  { entries: { [path]: FsEntry | null } }
 *     Per-path failures land as `null` (REST.md §3.9 line 524); only
 *     path-safety (41304) fails the whole call.
 *
 * Search endpoints:
 *
 *   POST /v1/sessions/{sid}/fs:search
 *     Body: FsSearchRequest   { query, limit?, include_globs?, exclude_globs?,
 *                               follow_gitignore? }
 *     Response data: FsSearchResponse  { items, truncated }
 *     Errors: 40401, 41303, 41304
 *
 *   POST /v1/sessions/{sid}/fs:grep
 *     Body: FsGrepRequest
 *     Response data: FsGrepResponse  { files, files_scanned, truncated,
 *                                      elapsed_ms }
 *     Errors: 40401, 41303, 41304, 41305 (>30s grep timeout)
 *
 * Git endpoint:
 *
 *   POST /v1/sessions/{sid}/fs:git_status
 *     Body: FsGitStatusRequest  { paths? }
 *     Response data: FsGitStatusResponse  { branch, ahead, behind, entries }
 *     Errors: 40401, 40908 (not a git repo), 41304
 *
 * Download endpoint:
 *
 *   GET /v1/sessions/{sid}/fs/{path}:download
 *     Architectural exception (REST.md §3.9 line 558): only verb-in-URL GET
 *     in the daemon. Path is wildcard, action suffix is `:download`.
 *
 *     Response:
 *       - HTTP 200: application/octet-stream + ETag + Content-Length +
 *                   Content-Disposition (success)
 *       - HTTP 206: + Content-Range (Range request)
 *       - HTTP 304: empty body (If-None-Match hit)
 *       - HTTP 200 + application/json: envelope (40401 / 40409 / 41304)
 *
 *     There's no body schema — only `FsDownloadParams` (path + headers).
 *
 * **Path safety**: every `path` / `paths[*]` field is validated in the daemon
 * route layer via `resolveSafePath(cwd, input)` — see
 * `packages/daemon/src/services/fs-path-safety.ts` and REST.md §4.4. The
 * schemas themselves do NOT enforce path safety (Zod doesn't know `cwd`);
 * they only enforce non-empty + reasonable batch sizes.
 *
 * **Batch failure semantics**:
 *   - `fs:list_many` uses REST.md §3.9 line 506-510 `{results,
 *     partial_errors?, truncated_paths?}` shape — per-path failures don't
 *     poison the whole response.
 *   - `fs:stat_many` per SCHEMAS §9.2 + REST.md §3.9 line 524
 *     `{entries: { [path]: FsEntry | null }}` — `null` indicates a
 *     per-path miss (most commonly 40409). The whole call only fails on
 *     path-safety (41304) of an input string.
 *
 * The discriminated-union `{kind: 'ok'} | {kind: 'err'}` shape is NOT what
 * REST.md §3.9 specifies; the spec uses a flat
 * map + sidecar error dict for `:list_many` and `null`-marker for
 * `:stat_many`. We follow the spec.
 *
 * **Search/grep caps**: both endpoints have client-tunable caps that default
 * to REST.md §3.9 numbers; the daemon also enforces a hard 30s timeout for
 * grep (`41305 fs.grep_timeout`). Search has a soft 500-hit cap — items
 * beyond 500 are dropped with `truncated: true`.
 *
 * Default thresholds (mirror REST.md §3.9 line 462-622):
 *   - `:list.depth`               default 1, max 10 (sane recursion bound)
 *   - `:list.limit`               default 200, max 1000
 *   - `:list_many.depth`          default 1, max 10
 *   - `:list_many.limit`          default 200, max 1000 (per-path)
 *   - `:list_many.paths.len`      max 100
 *   - `:read.length`              default 1048576 (1 MB), max 10485760 (10 MB)
 *   - `:stat_many.paths.len`      max 1000
 *   - `:search.limit`             default 50, max 200 (REST.md §3.9 line 583)
 *   - `:grep.max_files`           default 200
 *   - `:grep.max_matches_per_file` default 50
 *   - `:grep.max_total_matches`   default 5000
 *   - `:grep.context_lines`       default 2, max 10
 */

import { z } from 'zod';

import {
  fsEntrySchema,
  fsGitStatusSchema,
  fsGrepFileHitSchema,
  fsSearchHitSchema,
} from '../fs';

// --- Shared sort enum (REST.md §3.9 line 468) ------------------------------

export const fsListSortSchema = z.enum([
  'type_first',
  'name_asc',
  'name_desc',
  'mtime_desc',
  'size_desc',
]);
export type FsListSort = z.infer<typeof fsListSortSchema>;

// --- POST /v1/sessions/{sid}/fs:list          --------------------

export const fsListRequestSchema = z.object({
  /** Default '.' = session.cwd root. */
  path: z.string().default('.'),
  depth: z.number().int().min(1).max(10).default(1),
  limit: z.number().int().min(1).max(1000).default(200),
  show_hidden: z.boolean().default(false),
  follow_gitignore: z.boolean().default(true),
  exclude_globs: z.array(z.string()).optional(),
  sort: fsListSortSchema.default('type_first'),
  include_git_status: z.boolean().default(false),
});
export type FsListRequest = z.infer<typeof fsListRequestSchema>;

export const fsListResponseSchema = z.object({
  /** Direct children of `path`. */
  items: z.array(fsEntrySchema),
  /** Pre-expanded subtree per parent path; only present when `depth > 1`. */
  children_by_path: z.record(z.string(), z.array(fsEntrySchema)).optional(),
  /** True when `items` was capped at `limit`. */
  truncated: z.boolean(),
});
export type FsListResponse = z.infer<typeof fsListResponseSchema>;

// --- POST /v1/sessions/{sid}/fs:read          --------------------

export const fsReadEncodingRequestSchema = z.enum(['auto', 'utf-8', 'base64']);
export const fsReadEncodingResponseSchema = z.enum(['utf-8', 'base64']);
export type FsReadEncoding = z.infer<typeof fsReadEncodingResponseSchema>;

/**
 * Length cap is the spec's 10 MB (REST.md §3.9 line 535). Reads above 10 MB
 * total file size are rejected with `41302 fs.too_large` — NOT silently
 * truncated. The `length` param only bounds the bytes RETURNED, not the
 * fail-fast `41302` decision (which is based on full file size).
 */
export const fsReadRequestSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().min(1).max(10_485_760).default(1_048_576),
  encoding: fsReadEncodingRequestSchema.default('auto'),
});
export type FsReadRequest = z.infer<typeof fsReadRequestSchema>;

export const fsReadResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: fsReadEncodingResponseSchema,
  /** FULL file byte size (not just `content.length`). */
  size: z.number().int().nonnegative(),
  /** True if the returned `content` is a prefix of the file. */
  truncated: z.boolean(),
  etag: z.string(),
  mime: z.string(),
  language_id: z.string().optional(),
  /** Only set when `is_binary === false`. */
  line_count: z.number().int().nonnegative().optional(),
  is_binary: z.boolean(),
});
export type FsReadResponse = z.infer<typeof fsReadResponseSchema>;

// --- POST /v1/sessions/{sid}/fs:list_many          --------------

export const fsListManyRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(100),
  depth: z.number().int().min(1).max(10).default(1),
  limit: z.number().int().min(1).max(1000).default(200),
  show_hidden: z.boolean().default(false),
  follow_gitignore: z.boolean().default(true),
  exclude_globs: z.array(z.string()).optional(),
  sort: fsListSortSchema.default('type_first'),
  include_git_status: z.boolean().default(false),
});
export type FsListManyRequest = z.infer<typeof fsListManyRequestSchema>;

/**
 * REST.md §3.9 line 506: `results` maps the REQUESTED `path` string verbatim
 * to that path's `FsEntry[]`. Failed paths land in `partial_errors`; capped
 * paths land in `truncated_paths`. This is the wire-mandated shape (NOT a
 * discriminated union).
 */
export const fsListManyPartialErrorSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
});
export type FsListManyPartialError = z.infer<typeof fsListManyPartialErrorSchema>;

export const fsListManyResponseSchema = z.object({
  results: z.record(z.string(), z.array(fsEntrySchema)),
  truncated_paths: z.array(z.string()).optional(),
  partial_errors: z.record(z.string(), fsListManyPartialErrorSchema).optional(),
});
export type FsListManyResponse = z.infer<typeof fsListManyResponseSchema>;

// --- POST /v1/sessions/{sid}/fs:stat          -------------------

export const fsStatRequestSchema = z.object({
  path: z.string().min(1),
});
export type FsStatRequest = z.infer<typeof fsStatRequestSchema>;

export const fsStatResponseSchema = fsEntrySchema;
export type FsStatResponse = z.infer<typeof fsStatResponseSchema>;

// --- POST /v1/sessions/{sid}/fs:stat_many          --------------

export const fsStatManyRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(1000),
});
export type FsStatManyRequest = z.infer<typeof fsStatManyRequestSchema>;

/**
 * SCHEMAS §9.2 + REST.md §3.9 line 524: per-path `null` indicates a miss.
 * Path-safety failures (`41304`) on ANY input string fail the whole call —
 * the daemon route checks all paths up-front before any `fs.stat`.
 */
export const fsStatManyResponseSchema = z.object({
  entries: z.record(z.string(), fsEntrySchema.nullable()),
});
export type FsStatManyResponse = z.infer<typeof fsStatManyResponseSchema>;

// --- POST /v1/sessions/{sid}/fs:search          -----------------

/**
 * REST.md §3.9 line 580-588 verbatim:
 *
 *   { query: string,
 *     limit?: number,                  // default 50, max 200
 *     include_globs?: string[],
 *     exclude_globs?: string[],
 *     follow_gitignore?: boolean       // default true
 *   }
 *
 * The minimal-glob grammar (`*`, `**`, `?`) applies to the include/exclude
 * lists.
 */
export const fsSearchRequestSchema = z.object({
  /** Fuzzy filename query; e.g. `"buton"` matches `Button.tsx`. */
  query: z.string().min(1),
  /** Default 50, max 200 per REST.md §3.9 line 583. */
  limit: z.number().int().min(1).max(200).default(50),
  /** Whitelist globs (relative POSIX). Applied AFTER fuzzy + gitignore. */
  include_globs: z.array(z.string()).optional(),
  /** Blacklist globs (relative POSIX). Applied AFTER include. */
  exclude_globs: z.array(z.string()).optional(),
  /** Honor `.gitignore` while walking; default true. */
  follow_gitignore: z.boolean().default(true),
});
export type FsSearchRequest = z.infer<typeof fsSearchRequestSchema>;

export const fsSearchResponseSchema = z.object({
  items: z.array(fsSearchHitSchema),
  /** True if the daemon hit `limit` (or its internal 500 hard cap). */
  truncated: z.boolean(),
});
export type FsSearchResponse = z.infer<typeof fsSearchResponseSchema>;

// --- POST /v1/sessions/{sid}/fs:grep          -------------------

/**
 * REST.md §3.9 line 611-622 verbatim:
 *
 *   { pattern: string,
 *     regex?: boolean,                 // default false (literal)
 *     case_sensitive?: boolean,
 *     include_globs?: string[],
 *     exclude_globs?: string[],
 *     follow_gitignore?: boolean,      // default true
 *     max_files?: number,              // default 200
 *     max_matches_per_file?: number,   // default 50
 *     max_total_matches?: number,      // default 5000
 *     context_lines?: number           // default 2
 *   }
 *
 * The 30s hard timeout is enforced by the daemon, not the schema. Errors:
 * `41305 fs.grep_timeout` (>30s),
 * `41303 fs.too_many_results` (hit `max_total_matches`).
 */
export const fsGrepRequestSchema = z.object({
  /** Pattern string; interpreted as literal unless `regex: true`. */
  pattern: z.string().min(1),
  /** Treat `pattern` as a regex; default false. */
  regex: z.boolean().default(false),
  /** Case-sensitive matching; default true (matches ripgrep default). */
  case_sensitive: z.boolean().default(true),
  include_globs: z.array(z.string()).optional(),
  exclude_globs: z.array(z.string()).optional(),
  follow_gitignore: z.boolean().default(true),
  /** Max files visited; default 200. */
  max_files: z.number().int().min(1).max(10_000).default(200),
  /** Per-file match cap; default 50. */
  max_matches_per_file: z.number().int().min(1).max(10_000).default(50),
  /** Hard cap; default 5000. Hitting this returns `truncated: true`. */
  max_total_matches: z.number().int().min(1).max(100_000).default(5000),
  /** Context lines around each match; default 2 (10 max). */
  context_lines: z.number().int().min(0).max(10).default(2),
});
export type FsGrepRequest = z.infer<typeof fsGrepRequestSchema>;

export const fsGrepResponseSchema = z.object({
  files: z.array(fsGrepFileHitSchema),
  /** Number of files actually scanned (after gitignore + glob filters). */
  files_scanned: z.number().int().nonnegative(),
  /** True if any cap (`max_files` / `max_total_matches`) was hit. */
  truncated: z.boolean(),
  /** Wall-clock duration of the grep call, milliseconds. */
  elapsed_ms: z.number().int().nonnegative(),
});
export type FsGrepResponse = z.infer<typeof fsGrepResponseSchema>;

// --- POST /v1/sessions/{sid}/fs:git_status          -------------

/**
 * REST.md §3.9 line 653-657: request is `{paths?}` (omit for cwd-wide).
 * The optional `paths` filter scopes which paths the daemon includes in
 * the `entries` map; cwd-wide call walks everything `git status` reports.
 *
 * Errors: `40908 fs.git_unavailable` (cwd is not a git repo);
 * `41304 fs.path_escapes_session` if any input `paths[*]` escapes.
 */
export const fsGitStatusRequestSchema = z.object({
  /** Filter to specific paths; omit for cwd-wide. */
  paths: z.array(z.string().min(1)).optional(),
});
export type FsGitStatusRequest = z.infer<typeof fsGitStatusRequestSchema>;

/**
 * Response shape per REST.md §3.9 line 660-669:
 *   { branch: string,
 *     ahead: number,
 *     behind: number,
 *     entries: { [path]: GitStatus }   // SCHEMAS §9.2 line 521
 *   }
 *
 * `branch` is empty string when HEAD is detached (no current branch).
 * `ahead` / `behind` are 0 when no upstream is configured.
 */
export const fsGitStatusResponseSchema = z.object({
  /** Current branch; empty string when HEAD is detached. */
  branch: z.string(),
  /** Commits ahead of upstream; 0 when no upstream configured. */
  ahead: z.number().int().nonnegative(),
  /** Commits behind upstream; 0 when no upstream configured. */
  behind: z.number().int().nonnegative(),
  /** Path → status map. Empty when `git status` reports a clean tree. */
  entries: z.record(z.string(), fsGitStatusSchema),
});
export type FsGitStatusResponse = z.infer<typeof fsGitStatusResponseSchema>;

// --- GET /v1/sessions/{sid}/fs/{path}:download          ---------

/**
 * **Architectural exception** — REST.md §3.9 line 558 (the ONLY verb-in-URL
 * GET in the daemon REST surface).
 *
 * URL pattern (REST.md §3.9 line 562):
 *
 *   GET /v1/sessions/{sid}/fs/{path}:download
 *
 * `{path}` retains forward slashes; other special characters are
 * percent-encoded. Fastify's `:param` is single-segment, so the daemon
 * route uses a `*` wildcard to capture everything after `fs/`, then
 * peels off the `:download` action suffix.
 *
 * **Response is binary**, not envelope (REST.md §3.9 line 569):
 *   - HTTP 200: `application/octet-stream` + ETag + Content-Length + Content-Disposition
 *   - HTTP 206: + Content-Range (Range request)
 *   - HTTP 304: empty body (If-None-Match hit)
 *   - HTTP 200 + `application/json`: envelope (40401 / 40409 / 41304)
 *
 * **No request schema** in the strict sense — the request payload is
 * carried in URL + headers, not body. We surface a tiny `FsDownloadParams`
 * helper type for daemon-internal consumption.
 */
export const fsDownloadParamsSchema = z.object({
  /**
   * POSIX-style path, relative to `session.metadata.cwd`. The daemon
   * peels this from the wildcard after stripping the `:download` suffix.
   */
  path: z.string().min(1),
  /** Optional Range header value (e.g. `"bytes=0-65535"`). */
  range: z.string().optional(),
  /** Optional If-None-Match header value (etag string). */
  if_none_match: z.string().optional(),
});
export type FsDownloadParams = z.infer<typeof fsDownloadParamsSchema>;
