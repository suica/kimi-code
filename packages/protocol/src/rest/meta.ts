/**
 * `GET /v1/meta` response schema (REST.md §3.1).
 *
 * Returns daemon-level metadata: build version, declared protocol capabilities,
 * a per-process `daemon_id` (regenerated on every daemon restart), and the
 * `started_at` ISO timestamp the daemon went live at.
 *
 * Wire shape from REST.md §3.1 (envelope `data` field):
 *
 * ```ts
 * {
 *   daemon_version: string;          // e.g. "0.9.0"
 *   capabilities: {
 *     websocket: true,
 *     file_upload: true,
 *     fs_query: true,
 *     mcp: true,
 *     background_tasks: true,
 *   },
 *   daemon_id: string;               // ULID; reset on every restart
 *   started_at: IsoDateTime;
 * }
 * ```
 *
 * Capabilities are fixed `true` literals because the daemon ships every
 * advertised capability. If optional capabilities land later (auth, etc.) the
 * schema becomes a `z.boolean()` per key. Clients treat missing keys as
 * `false`; bumping a capability from `true` to "missing" is therefore a
 * protocol-compatible cut.
 *
 * REST.md §3.1 is the authoritative wire contract; `sdk_version` /
 * `default_cwd` are intentionally not exposed here.
 */
import { z } from 'zod';

import { isoDateTimeSchema } from '../time';

export const metaCapabilitiesSchema = z.object({
  websocket: z.literal(true),
  file_upload: z.literal(true),
  fs_query: z.literal(true),
  mcp: z.literal(true),
  background_tasks: z.literal(true),
});

export type MetaCapabilities = z.infer<typeof metaCapabilitiesSchema>;

export const metaResponseSchema = z.object({
  daemon_version: z.string().min(1),
  capabilities: metaCapabilitiesSchema,
  daemon_id: z.string().min(1),
  started_at: isoDateTimeSchema,
});

export type MetaResponse = z.infer<typeof metaResponseSchema>;
