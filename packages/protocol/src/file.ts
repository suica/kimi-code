/**
 * File / Upload entity schema (SCHEMAS.md §9.1).
 *
 * Wire shape: `FileMeta` — single canonical entity returned by `POST
 * /v1/files`, looked up by `GET /v1/files/{file_id}` (binary stream OR
 * 40407 envelope), and dropped by `DELETE /v1/files/{file_id}`.
 *
 * **Daemon-OWN** (not bridged via ICoreProcessService): `IFileStore` is
 * implemented in `packages/daemon/src/services/file-store.ts` against the
 * local filesystem (`~/.kimi/files/<id>` blob + `~/.kimi/files/index.json`
 * metadata). Agent-core has no `file` surface — this is the second
 * daemon-OWN entity after `FsEntry` / `FsChangeEvent`.
 *
 * Field semantics (SCHEMAS §9.1 line 502-509):
 *   - `id`           daemon-minted ULID. Time-sortable.
 *   - `name`         filename as uploaded (preserved verbatim — useful
 *                    for `Content-Disposition: attachment` on download).
 *   - `media_type`   RFC 6838 media type. Defaults to the multipart
 *                    field's `mimetype` if the client passed one; else
 *                    `application/octet-stream`.
 *   - `size`         byte length of the blob on disk.
 *   - `created_at`   ISO 8601 UTC mint timestamp.
 *   - `expires_at`   optional; absent means "no expiry" (the first
 *                    daemon version doesn't garbage-collect, but the
 *                    field is reserved for it — REST.md §3.10 line 681:
 *                    `expires_in_sec` default 86400).
 *
 * **Anti-corruption**: zero `@moonshot-ai/agent-core` imports — `files`
 * is a daemon-self surface, so the protocol schemas describe the daemon's
 * wire shape directly without an SDK round-trip.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './time';

/**
 * `FileMeta` — single canonical file metadata entity (SCHEMAS §9.1).
 *
 * Same shape returned from `POST /v1/files` (upload completion) AND
 * embedded in the future `event.file.uploaded` WS event (WS.md §4.8 —
 * deferred). The `GET /v1/files/{id}` download endpoint does NOT return
 * this shape: it streams binary bytes with `Content-Type` and
 * `Content-Disposition` headers (REST.md §3.10).
 */
export const fileMetaSchema = z.object({
  /** Daemon-minted ULID. Time-sortable. */
  id: z.string().min(1),
  /** Filename as uploaded (verbatim, including extension). */
  name: z.string().min(1),
  /** RFC 6838 media type, e.g. `'image/png'`, `'application/octet-stream'`. */
  media_type: z.string().min(1),
  /** Blob size in bytes (post-write). */
  size: z.number().int().nonnegative(),
  created_at: isoDateTimeSchema,
  /** Absent = no expiry. Reserved for the GC pass (deferred). */
  expires_at: isoDateTimeSchema.optional(),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;
