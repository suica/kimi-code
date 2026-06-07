/**
 * Filesystem entity schemas (SCHEMAS.md §9.2, Chains 9 + 10 / P1.9 + P1.10,
 * W10).
 *
 * Wire shape: snake_case fields; ISO 8601 `Z`-suffix timestamps via
 * `isoDateTimeSchema`. All `path` fields are POSIX-style relative paths
 * anchored at `session.metadata.cwd` (REST.md §3.9 line 451).
 *
 * **Daemon-OWN** (not bridged via ICoreProcessService): `IFsService` is implemented
 * in `packages/daemon/src/services/fs-service.ts` against Node `fs.promises`
 * with explicit path-safety guards (REST.md §4.4). Agent-core has no `fs`
 * surface — this is the first daemon-self service in the W3+ DI graph.
 *
 * Single canonical type per SCHEMAS §9.2:
 *
 *   FsEntry { path, name, kind, size?, modified_at, etag?, mime?,
 *             language_id?, is_binary?, is_symlink_to?, git_status?,
 *             child_count? }
 *
 * Field semantics (SCHEMAS §9.2 line 547-552):
 *   - `mime` / `language_id` / `is_binary` are REQUIRED on `:stat` / `:read`
 *     responses and OPTIONAL on `:list` (filename + magic-byte sniff).
 *   - `git_status` is only filled when client opts in via `include_git_status`
 *     (avoids `git status` blocking large-repo `:list` first paint).
 *   - `child_count` only set for directory entries in `:list` results.
 *   - `etag` is `mtime + size + inode` sha1 (mirror of VSCode's
 *     FileSystemProvider — not strong-consistent).
 *
 * Chain 9 (W10.1) covers `:list` + `:read`; Chain 10 (W10.2) covers
 * `:list_many` + `:stat` + `:stat_many`. `:download` / `:search` / `:grep` /
 * `:git_status` arrive in W11+.
 *
 * **Anti-corruption**: zero `@moonshot-ai/agent-core` imports — `fs` is a
 * daemon-self surface, so the protocol schemas describe the daemon's wire
 * shape directly without an SDK round-trip.
 *
 * W11 additions (Chains 11 + 12):
 *   - `FsSearchHit`        — `:search` item (path + name + kind + score +
 *                            match positions). NOT a discriminated union
 *                            with `FsGrepMatch`; they're two different
 *                            shapes per REST.md §3.9.
 *   - `FsGrepMatch`        — `:grep` per-line hit (line + col + text +
 *                            before / after context).
 *   - `FsGitStatusEntry`   — `:git_status` per-path entry. Reuses the
 *                            existing `FsGitStatus` enum from W10 (verbatim
 *                            SCHEMAS §9.2 line 521) rather than introducing
 *                            a new XY-pair shape; REST.md §3.9 line 666
 *                            specifies the map shape `{[path]: GitStatus}`.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './time';

// --- 9.2 FsKind -------------------------------------------------------------

/**
 * `FsKind` — wire enum mirroring SCHEMAS §9.2 line 519. We deliberately use
 * `directory` (full word) rather than `dir`; matches SCHEMAS verbatim.
 *
 * `symlink` is reported as its own kind regardless of target type; resolving
 * to the underlying file/dir is the client's responsibility (or the daemon's
 * when `is_symlink_to` chases through one hop).
 */
export const fsKindSchema = z.enum(['file', 'directory', 'symlink']);
export type FsKind = z.infer<typeof fsKindSchema>;

// --- 9.2 GitStatus ----------------------------------------------------------

/**
 * `GitStatus` — SCHEMAS §9.2 line 521. Surfaced on `FsEntry.git_status` when
 * client passes `include_git_status: true` in `:list` / `:list_many`. Not
 * exposed yet for `:stat` (Chain 10 stays git-quiet; W11 adds `:git_status`).
 */
export const fsGitStatusSchema = z.enum([
  'clean',
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'ignored',
  'conflicted',
]);
export type FsGitStatus = z.infer<typeof fsGitStatusSchema>;

// --- 9.2 FsEntry ------------------------------------------------------------

/**
 * `FsEntry` — single canonical filesystem entity (SCHEMAS §9.2 line 531).
 *
 * Used as:
 *   - Each item of `:list` / `:list_many` response items.
 *   - The full payload of `:stat` and each item of `:stat_many`.
 *   - Inline reference in `:read` is via the separate `FsReadResponse` shape
 *     (content + size + etag, no full entry).
 *
 * `child_count` on `directory` entries enables virtual scrolling without a
 * second round-trip; daemon populates it when the dir is the direct subject
 * of `:list` (not when it's a child of a `depth>1` recursion).
 */
export const fsEntrySchema = z.object({
  /** POSIX-style, relative to `session.metadata.cwd`. */
  path: z.string(),
  /** Base name (last segment of `path`). */
  name: z.string(),
  kind: fsKindSchema,
  /** Bytes for `file`; may be omitted for `directory` / `symlink`. */
  size: z.number().int().nonnegative().optional(),
  modified_at: isoDateTimeSchema,
  /** `sha1(mtime + size + inode)` — for client-side cache invalidation. */
  etag: z.string().optional(),
  /** RFC 6838 media type, e.g. `'text/typescript'`, `'image/png'`. */
  mime: z.string().optional(),
  /** Monaco language id, e.g. `'typescript'`, `'markdown'`. */
  language_id: z.string().optional(),
  /** Heuristic from first 4KB sniff (null byte or > 30% non-printable). */
  is_binary: z.boolean().optional(),
  /** Symlink target relative path; only set when `kind === 'symlink'`. */
  is_symlink_to: z.string().optional(),
  /** Only set when client passed `include_git_status: true` on the request. */
  git_status: fsGitStatusSchema.optional(),
  /** Only set for `directory` entries in `:list` direct-child results. */
  child_count: z.number().int().nonnegative().optional(),
});
export type FsEntry = z.infer<typeof fsEntrySchema>;

// --- 9.x FsSearchHit (W11 / Chain 11) --------------------------------------

/**
 * `FsSearchHit` — single item of `:search` response (REST.md §3.9 line 593).
 *
 * Fuzzy filename match (Cmd+P style). `score` is `0..1` — client uses it
 * for stable ordering of the response; daemon already returns items in
 * descending-score order. `match_positions` are character offsets into
 * `path` so the client can highlight matched characters in the UI.
 */
export const fsSearchHitSchema = z.object({
  /** POSIX-style path, relative to `session.metadata.cwd`. */
  path: z.string(),
  /** Base name (last segment of `path`). */
  name: z.string(),
  kind: fsKindSchema,
  /** 0..1 fuzzy match score; daemon orders by this. */
  score: z.number().min(0).max(1),
  /** Character indices into `path` of the matched chars (UI highlight hint). */
  match_positions: z.array(z.number().int().nonnegative()),
});
export type FsSearchHit = z.infer<typeof fsSearchHitSchema>;

// --- 9.x FsGrepMatch (W11 / Chain 11) --------------------------------------

/**
 * `FsGrepMatch` — single per-line hit inside one file's `matches[]` array of
 * the `:grep` response (REST.md §3.9 line 630-638).
 *
 * `line` / `col` are **1-based** (matches `ripgrep --json`'s output). `col`
 * is a byte offset (not character) per REST.md §3.9 line 633.
 *
 * `before` / `after` are the surrounding lines if `context_lines > 0`, in
 * file order. They do NOT include the matching line itself (which is
 * `text`).
 */
export const fsGrepMatchSchema = z.object({
  /** 1-based line number. */
  line: z.number().int().positive(),
  /** 1-based byte offset of the match start within the line. */
  col: z.number().int().positive(),
  /** The matching line (no trailing newline). */
  text: z.string(),
  /** Context lines BEFORE `text`, in file order. */
  before: z.array(z.string()),
  /** Context lines AFTER `text`, in file order. */
  after: z.array(z.string()),
});
export type FsGrepMatch = z.infer<typeof fsGrepMatchSchema>;

/**
 * `FsGrepFileHit` — one file's bundle of matches in the `:grep` response.
 * REST.md §3.9 line 629-638 specifies a nested shape (file → matches), not
 * a flat per-match list — this is to amortize the file path across many
 * hits in editor UIs.
 */
export const fsGrepFileHitSchema = z.object({
  /** POSIX-style path, relative to `session.metadata.cwd`. */
  path: z.string(),
  /** All matches inside this file (capped per `max_matches_per_file`). */
  matches: z.array(fsGrepMatchSchema),
});
export type FsGrepFileHit = z.infer<typeof fsGrepFileHitSchema>;

// --- 9.x FsGitStatusEntry (W11 / Chain 12) ---------------------------------

/**
 * `FsGitStatusEntry` — single row of `:git_status` response.
 *
 * REST.md §3.9 line 666 specifies the wire shape as `{[path]: GitStatus}`
 * — a flat map of path → enum. We surface it as a record (see
 * `fsGitStatusResponseSchema` in `rest/fs.ts`). This `FsGitStatusEntry`
 * is the per-entry object used INTERNALLY by the daemon's git porcelain
 * parser before being collapsed to the wire map.
 *
 * The internal entry retains `worktree_status` + `index_status` separately
 * so we can decide which "winning" status to surface on the wire (priority:
 * conflict > deleted > modified > added > renamed > untracked > ignored >
 * clean). The single wire enum loses the index/worktree distinction
 * deliberately — most clients just paint a badge.
 *
 * **Not exposed on the wire**: this type is daemon-internal. The wire uses
 * `FsGitStatus` (the existing W10 enum).
 */
export const fsGitStatusEntrySchema = z.object({
  /** POSIX-style path, relative to `session.metadata.cwd`. */
  path: z.string(),
  /** Final, single-value status that lands on the wire map. */
  status: fsGitStatusSchema,
  /** Original rename source (porcelain XY = `R `), if any. */
  rename_from: z.string().optional(),
});
export type FsGitStatusEntry = z.infer<typeof fsGitStatusEntrySchema>;

// --- 9.x FsChangeEntry / FsChangeEvent (W12 / Chain 14) --------------------

/**
 * `FsChangeKind` — kind of filesystem entity the change applies to. Mirrors
 * WS.md §4.9 (`'file' | 'directory' | 'symlink'`). Same value-space as
 * `FsKind` above; we re-derive rather than re-export so the change wire
 * shape stays self-contained — if WS.md ever splits the change-entity
 * vocabulary from the listing vocabulary we can evolve them independently.
 */
export const fsChangeKindSchema = z.enum(['file', 'directory', 'symlink']);
export type FsChangeKind = z.infer<typeof fsChangeKindSchema>;

/**
 * `FsChangeAction` — what happened to the entry. WS.md §4.9 specifies
 * `'created' | 'modified' | 'deleted'` (NOT chokidar's raw event names
 * `'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'`). The daemon-side
 * fs-watcher collapses chokidar's 5-event vocabulary into this 3-action
 * wire shape:
 *
 *   chokidar `add` / `addDir`             → `'created'`
 *   chokidar `change`                     → `'modified'`
 *   chokidar `unlink` / `unlinkDir`       → `'deleted'`
 *
 * Directory kind is preserved on the entry separately via `kind`.
 */
export const fsChangeActionSchema = z.enum(['created', 'modified', 'deleted']);
export type FsChangeAction = z.infer<typeof fsChangeActionSchema>;

/**
 * `FsChangeEntry` — single change inside an `event.fs.changed` payload
 * (WS.md §4.9). Multiple entries are coalesced into one event over a
 * 200ms window (`coalesced_window_ms` on the event payload).
 *
 * `path` is POSIX-style, anchored at `session.metadata.cwd` — same
 * convention as the rest of the fs surface (REST.md §3.9 line 451).
 *
 * `size_delta` is set on `change` events to a `file` for which we observed
 * a size delta; optional because chokidar doesn't always re-stat on every
 * event and we don't want to block the debouncer on per-event stats.
 *
 * `etag` mirrors `FsEntry.etag` (sha1 of `mtime + size + inode`) — set
 * when the change is a `modified` / `created` `file` AND a fast stat was
 * cheap. Optional for the same reason as `size_delta`.
 */
export const fsChangeEntrySchema = z.object({
  /** POSIX-style path, relative to `session.metadata.cwd`. */
  path: z.string(),
  change: fsChangeActionSchema,
  kind: fsChangeKindSchema,
  /** `new_size - old_size` for files; optional (best-effort). */
  size_delta: z.number().int().optional(),
  /** Fresh etag for files; optional (best-effort, see FsEntry.etag). */
  etag: z.string().optional(),
});
export type FsChangeEntry = z.infer<typeof fsChangeEntrySchema>;

/**
 * `FsChangeEvent` — payload of the `event.fs.changed` WS frame (WS.md §4.9).
 *
 * Wire shape:
 *
 *   {
 *     changes: FsChangeEntry[],     // empty when truncated=true
 *     coalesced_window_ms: 200,
 *     truncated?: boolean,           // true when > 500 changes in one window
 *     count?: number                 // total raw change count when truncated
 *   }
 *
 * **Truncation contract** (WS.md §4.9 + ROADMAP Chain 14 AC #2): when the
 * daemon collects more than 500 raw chokidar events inside the 200ms
 * coalesce window (e.g. `git checkout` swapping a branch), it stops
 * accumulating per-entry detail and instead emits a single event with
 * `truncated: true` and `count: <raw event count>`. The client is expected
 * to throw away its in-memory fs tree state and re-`:list` to resync —
 * the daemon does NOT chase up with a fix-up event.
 *
 * `coalesced_window_ms` is always echoed (= 200) so client can adapt UI
 * batching; if the daemon ever tunes the window per-session it surfaces
 * here.
 */
export const fsChangeEventSchema = z.object({
  changes: z.array(fsChangeEntrySchema),
  coalesced_window_ms: z.number().int().positive(),
  truncated: z.boolean().optional(),
  count: z.number().int().nonnegative().optional(),
});
export type FsChangeEvent = z.infer<typeof fsChangeEventSchema>;
