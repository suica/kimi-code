/**
 * File REST endpoint schemas (REST.md §3.10).
 *
 * Three endpoints:
 *
 *   POST   /v1/files
 *     Request: multipart/form-data with `file` (binary), `name`
 *              (optional override), `expires_in_sec` (optional).
 *     Response data: `FileMeta` (full envelope).
 *     Errors: 41301 (>50MB).
 *
 *   GET    /v1/files/{file_id}
 *     **The only endpoint in the daemon that does NOT use the envelope**
 *     (REST.md §3.10 line 691: "唯一不走 envelope 的端点"). Response:
 *     - 200: `application/octet-stream` + `Content-Disposition` +
 *            `ETag` + `Content-Length` + raw bytes.
 *     - 404: `{code:40407, msg:'file not found', ...}` envelope
 *            (client checks `Content-Type` to disambiguate).
 *     - 410: `{code:41003, msg:'file expired', ...}` (reserved; no GC pass
 *            currently removes expired files).
 *
 *   DELETE /v1/files/{file_id}
 *     Response data: `{deleted: true}` (envelope-wrapped).
 *     Errors: 40407.
 *
 * The upload request shape isn't a Zod schema (multipart bypasses
 * `body` JSON validation in Fastify); instead the route handler
 * uses `@fastify/multipart` to stream the upload directly to disk.
 *
 * **Anti-corruption**: zero SDK imports.
 */

import { z } from 'zod';

import { fileMetaSchema } from '../file';

/* --------------------------------------------------------------------------
 * POST /v1/files
 * ------------------------------------------------------------------------ */

/**
 * Response shape for `POST /v1/files` is just `FileMeta`. We re-export
 * `fileMetaSchema` as `uploadFileResponseSchema` so the route layer can
 * (optionally) re-validate before sending — though in practice we just
 * stuff the meta directly into the envelope.
 */
export const uploadFileResponseSchema = fileMetaSchema;
export type UploadFileResponse = z.infer<typeof uploadFileResponseSchema>;

/* --------------------------------------------------------------------------
 * GET /v1/files/{file_id}
 *
 * The response is a binary stream (no envelope). We export a
 * `params` schema for path validation; the response body is not
 * representable as Zod since it's a `Buffer` / `ReadableStream`.
 * ------------------------------------------------------------------------ */

export const getFileParamSchema = z.object({
  file_id: z.string().min(1),
});
export type GetFileParam = z.infer<typeof getFileParamSchema>;

/* --------------------------------------------------------------------------
 * DELETE /v1/files/{file_id}
 * ------------------------------------------------------------------------ */

export const deleteFileParamSchema = z.object({
  file_id: z.string().min(1),
});
export type DeleteFileParam = z.infer<typeof deleteFileParamSchema>;

export const deleteFileResponseSchema = z.object({
  deleted: z.literal(true),
});
export type DeleteFileResponse = z.infer<typeof deleteFileResponseSchema>;
