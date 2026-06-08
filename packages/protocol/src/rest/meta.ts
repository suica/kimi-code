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
 * Capabilities are FIXED `true` literals at this stage — the first daemon
 * version ships every advertised capability; once optional capabilities land
 * (auth, etc.) the schema becomes a `z.boolean()` per key. Clients are
 * documented as treating missing keys as `false`; bumping a capability from
 * `true` to "missing" is therefore a protocol-compatible cut.
 *
 * Note on ROADMAP vs REST.md divergence: ROADMAP Chain 1 (P1.1) says
 * "daemon / sdk version + default cwd". REST.md §3.1 — which is the
 * authoritative wire contract — says `{daemon_version, capabilities,
 * daemon_id, started_at}`. We follow REST.md; `sdk_version` / `default_cwd`
 * are intentionally NOT exposed here (see STATUS.md §Decisions).
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
