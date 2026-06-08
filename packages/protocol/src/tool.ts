/**
 * Tool + MCP entity schemas (SCHEMAS.md §8).
 *
 * Wire shape: snake_case, lower_case enum literals; ISO 8601 `Z`-suffix
 * timestamps via `isoDateTimeSchema` (no timestamps in §8 today — kept here
 * for symmetry should agent-core start surfacing `last_connected_at` etc.).
 *
 * Agent-core surfaces these in two camelCase shapes:
 *
 *   `ToolInfo` (packages/agent-core/src/agent/tool/types.ts:13)
 *     - `name`, `description`, `active`, `source: 'builtin'|'user'|'mcp'`
 *
 *   `McpServerInfo` (packages/agent-core/src/rpc/core-api.ts:220)
 *     - `name`, `transport: 'stdio'|'http'`, `status: 'pending'|'connected'|
 *       'failed'|'disabled'|'needs-auth'`, `toolCount`, `error?`
 *
 * Adapters (`packages/services/src/adapter/tool-adapter.ts`) translate the
 * agent-core shapes to the wire shape below. Key shape gaps + decisions:
 *
 *   - `ToolDescriptor.source = 'builtin' | 'skill' | 'mcp'` per SCHEMAS §8 —
 *     agent-core has `'user'` instead of `'skill'`. The adapter maps
 *     `'user' → 'skill'` (kosong's notion of "user tool" is a skill). We
 *     accept ONLY the spec literals on the wire; consumers can't see the
 *     agent-core variant.
 *
 *   - `ToolDescriptor.input_schema` per SCHEMAS §8: agent-core's `ToolInfo`
 *     doesn't surface a JSON schema today (kosong holds it on
 *     `ExecutableTool.input.toJSON()` but `getTools` doesn't return it). We
 *     accept `z.unknown()` and emit `null` from the adapter — clients
 *     treating missing as opaque per SCHEMAS' "未知字段宽松" principle.
 *
 *   - `ToolDescriptor.mcp_server_id` per SCHEMAS §8: agent-core qualifies
 *     mcp tool names as `mcp:<server>:<tool>`. The adapter parses that
 *     prefix when `source === 'mcp'`. When parsing fails we omit the field.
 *
 *   - `McpServer.id` per SCHEMAS §8: agent-core's `McpServerInfo` has only
 *     `name` (no separate id). We adopt name-as-id at the wire boundary —
 *     daemon callers refer to mcp servers by name; both are 1:1 and stable
 *     across a daemon process lifetime.
 *
 *   - `McpServerStatus` per SCHEMAS §8 has 4 literals
 *     (`'connected'|'connecting'|'disconnected'|'error'`); agent-core has 5
 *     (`'pending'|'connected'|'failed'|'disabled'|'needs-auth'`). Mapping:
 *       agent-core 'pending'    → wire 'connecting'
 *       agent-core 'connected'  → wire 'connected'
 *       agent-core 'failed'     → wire 'error'
 *       agent-core 'disabled'   → wire 'disconnected'
 *       agent-core 'needs-auth' → wire 'error'   (last_error tells user)
 *     Documented in `tool-adapter.ts`.
 *
 *   - `McpServer.transport` per SCHEMAS §8 has 3 literals (`'stdio'|'http'|'sse'`);
 *     agent-core has 2 (`'stdio'|'http'`). Adapter passes through; wire
 *     stays a superset so future SSE transport can land without a
 *     schema-version bump.
 *
 *   - `McpServer.last_error` per SCHEMAS §8 ↔ agent-core's `error?`.
 *     Renamed at the adapter boundary; both are free-form strings.
 *
 * **Anti-corruption**: this file imports zero `@moonshot-ai/agent-core` types.
 * The agent-core shapes are referenced ONLY at the services adapter layer.
 */

import { z } from 'zod';

// --- 8 ToolDescriptor -------------------------------------------------------

export const toolSourceSchema = z.enum(['builtin', 'skill', 'mcp']);
export type ToolSource = z.infer<typeof toolSourceSchema>;

/**
 * SCHEMAS §8 calls this `ToolDescriptor`. To keep the package barrel uncluttered
 * we expose both names from the service adapter; the schema is the canonical
 * value.
 */
export const toolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /**
   * SCHEMAS §8 documents this as a JSON schema; agent-core does not surface
   * per-tool JSON schema via `getTools`. We accept `z.unknown()` so the
   * adapter can emit `null` until the surface lands. Clients should treat
   * `null` / missing as "schema unknown" (per SCHEMAS "未知字段宽松").
   */
  input_schema: z.unknown(),
  source: toolSourceSchema,
  /** Set only when `source === 'mcp'`. */
  mcp_server_id: z.string().min(1).optional(),
});
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

// --- 8 McpServer ------------------------------------------------------------

export const mcpServerStatusSchema = z.enum([
  'connected',
  'connecting',
  'disconnected',
  'error',
]);
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const mcpServerTransportSchema = z.enum(['stdio', 'http', 'sse']);
export type McpServerTransport = z.infer<typeof mcpServerTransportSchema>;

export const mcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: mcpServerTransportSchema,
  status: mcpServerStatusSchema,
  /** Free-form upstream error message. Omitted when status !== 'error'. */
  last_error: z.string().optional(),
  tool_count: z.number().int().nonnegative(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;
