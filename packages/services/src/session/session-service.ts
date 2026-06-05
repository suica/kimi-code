/**
 * `ISessionService` — daemon-facing session CRUD interface (Chain 2 / P1.2).
 *
 * Wraps `IHarnessBridge.rpc.{createSession, listSessions, closeSession,
 * updateSessionMetadata}` and adapts agent-core's camelCase + number
 * timestamps to the protocol's snake_case + ISO 8601 `Z` shape (see SCHEMAS.md
 * §2). The adapter is the load-bearing piece of this chain — every later
 * service in `@moonshot-ai/services` (messages, prompts, ...) inherits this
 * camelCase ↔ snake_case + number ↔ ISO pattern.
 *
 * **Why a service layer**: REST handlers in `@moonshot-ai/daemon` are
 * disallowed from importing `@moonshot-ai/kimi-code-sdk` (anti-corruption
 * test). Routes call `accessor.get(ISessionService).<method>(...)`; the
 * adapter is here.
 *
 * **CoreAPI shape gap**: agent-core does NOT expose `getSession(id)` returning
 * a full `SessionSummary` — `getSessionMetadata` returns the smaller
 * `SessionMeta` shape. `get(id)` is implemented via `listSessions({})` +
 * filter, throwing `SessionNotFoundError` (→ 40401) when the id is absent.
 * See `SessionService` for details + the gap documentation.
 *
 * **Adapter helpers**: `toProtocolSession` is co-located here (moved from
 * `adapter/` in Phase B per-domain consolidation).
 *
 * **DI wiring**: this class takes `IHarnessBridge` via ctor positional arg.
 * `defaultServicesModule()` adds a `SyncDescriptor(SessionService)` entry,
 * but W2's container has no ctor-arg DI, so the daemon's `start.ts` wires it
 * via `ix.createInstance(SessionService, a.get(IHarnessBridge))` then
 * `services.set(ISessionService, instance)` — same pattern as HarnessBridge
 * in W4. The descriptor entry is the canonical declaration; the daemon's
 * manual wiring is the runtime path.
 *
 * **Anti-corruption**: this file imports from `@moonshot-ai/agent-core` only
 * for type-only `SessionSummary` / `SessionMeta`. Runtime calls go through
 * `IHarnessBridge.rpc.<method>`, not direct CoreAPI consumption.
 */

import { createDecorator, Disposable } from '@moonshot-ai/agent-core';
import type { JsonObject, SessionMeta, SessionSummary } from '@moonshot-ai/agent-core';
import {
  emptySessionUsage,
  type PageResponse,
  type Session,
  type SessionCreate,
  type SessionUpdate,
} from '@moonshot-ai/protocol';
import type {
  CursorQuery,
} from '@moonshot-ai/protocol';

import { IHarnessBridge } from '../bridge/harness-bridge';

/**
 * Listing query — `before_id`/`after_id` + `page_size` mutual exclusivity is
 * already enforced by `cursorQuerySchema`. The service layer adds an optional
 * status filter the daemon layer parses out of the REST query string.
 */
export interface SessionListQuery extends CursorQuery {
  status?: import('@moonshot-ai/protocol').SessionStatus;
}

export interface ISessionService {
  readonly _serviceBrand: undefined;

  /**
   * `POST /v1/sessions` — create a new session. Requires `metadata.cwd`
   * (agent-core's `createSession` calls `requiredWorkDir`; missing cwd ⇒ throw).
   */
  create(input: SessionCreate): Promise<Session>;

  /**
   * `GET /v1/sessions` — list sessions. Cursor pagination is applied
   * client-side over `bridge.rpc.listSessions({})` (the CoreAPI surface
   * doesn't take a cursor today — see W6 STATUS Decisions). Default
   * `page_size = 20` per REST.md §1.6 is applied at the route layer, not here.
   */
  list(query: SessionListQuery): Promise<PageResponse<Session>>;

  /**
   * `GET /v1/sessions/{id}` — single session by id. Implemented as
   * `listSessions({}) + .find(id)`; throws `SessionNotFoundError` (→ 40401)
   * when not found.
   */
  get(id: string): Promise<Session>;

  /**
   * `PATCH /v1/sessions/{id}` — partial update. Backed by
   * `updateSessionMetadata` for metadata changes; `title` writes through the
   * same path (mapped onto agent-core's `SessionMeta.title`).
   * Returns the post-update Session.
   */
  update(id: string, input: SessionUpdate): Promise<Session>;

  /**
   * `DELETE /v1/sessions/{id}` — close (= soft-delete in v1) the session.
   * Backed by `bridge.rpc.closeSession({sessionId})`. CoreAPI does not
   * surface a hard delete; first daemon version conflates close == delete
   * (see W6 STATUS Decisions).
   *
   * Returns `{ deleted: true }` envelope shape per REST §3.3.
   */
  delete(id: string): Promise<{ deleted: true }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISessionService = createDecorator<ISessionService>('sessionService');

/**
 * Sentinel error class — daemon's route layer catches this and maps to
 * `code: 40401` (session.not_found). Other errors fall through to the W4
 * `installErrorHandler` (→ 50001 internal).
 */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Treat the incoming `metadata` object — schema-validated by zod as
 * `{cwd: string}` plus arbitrary `unknown` keys — as a JSON-safe object for
 * agent-core's `JsonObject` slot. We don't deep-validate here; clients can
 * send non-JSON-serializable values and agent-core will reject at the RPC
 * boundary. This cast keeps the adapter narrow and the wire stable.
 */
function asJsonObject(value: Record<string, unknown>): JsonObject {
  return value as unknown as JsonObject;
}

/**
 * Convert agent-core's `SessionSummary` + optional `SessionMeta` into the
 * protocol-level `Session` shape. The optional `meta` argument is the result
 * of `getSessionMetadata` — when present, its `title` / `custom` enrich the
 * baseline summary; when absent, defaults are used.
 *
 * `cwd` overrides apply in this priority order:
 *   1. `meta.custom.cwd` (set by daemon when update wrote a new cwd).
 *   2. `summary.metadata.cwd` (when caller-supplied during create).
 *   3. `summary.workDir` (agent-core canonical field).
 *
 * The merged `Session.metadata` keeps `cwd` plus anything in `meta.custom`
 * (excluding daemon-internal `goal` plumbing — that's not protocol surface).
 */
export function toProtocolSession(
  summary: SessionSummary,
  meta?: SessionMeta | undefined,
): Session {
  const summaryMetadata = (summary.metadata ?? {}) as Record<string, unknown>;
  const customMetadata = (meta?.custom ?? {}) as Record<string, unknown>;
  const cwd =
    (typeof customMetadata['cwd'] === 'string' && (customMetadata['cwd'] as string)) ||
    (typeof summaryMetadata['cwd'] === 'string' && (summaryMetadata['cwd'] as string)) ||
    summary.workDir;

  // Strip the internal "goal" key — that's daemon-side runtime state, not
  // protocol surface (SCHEMAS §2 doesn't expose it).
  const { goal: _drop, ...customWithoutGoal } = customMetadata;

  const mergedMetadata: Session['metadata'] = {
    ...customWithoutGoal,
    cwd,
  };

  const title = meta?.title ?? summary.title ?? '';

  return {
    id: summary.id,
    title,
    created_at: new Date(summary.createdAt).toISOString(),
    updated_at: new Date(summary.updatedAt).toISOString(),
    status: 'idle',
    metadata: mergedMetadata,
    agent_config: {
      // CoreAPI doesn't surface a session's effective model on the listSessions
      // path; we leave it empty and let later chains populate via getModel
      // (chain 3+). Empty string keeps the schema valid for downstream
      // consumers that only inspect known keys.
      model: '',
    },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

export class SessionService extends Disposable implements ISessionService {
  readonly _serviceBrand: undefined;

  constructor(@IHarnessBridge private readonly bridge: IHarnessBridge) {
    super();
  }

  async create(input: SessionCreate): Promise<Session> {
    // SessionCreate.metadata.cwd is REQUIRED by Zod; agent-core's createSession
    // also calls `requiredWorkDir(...)` which throws if missing.
    const metadataForCore = asJsonObject(input.metadata as Record<string, unknown>);
    const summary = await this.bridge.rpc.createSession({
      workDir: input.metadata.cwd,
      metadata: metadataForCore,
      ...(input.agent_config?.model !== undefined ? { model: input.agent_config.model } : {}),
    });
    // agent-core's createSession ignores any caller-supplied title — newly
    // created sessions get the default `SessionMeta.title = 'New Session'`.
    // When the caller supplied a title we apply it via `renameSession` so the
    // post-create get reflects it.
    if (input.title !== undefined) {
      try {
        await this.bridge.rpc.renameSession({ sessionId: summary.id, title: input.title });
      } catch {
        // If rename fails (e.g. session closed/race), continue with the
        // default — the response shape is unchanged.
      }
    }
    const meta = await this.tryGetMeta(summary.id);
    return toProtocolSession(summary, meta);
  }

  async list(query: SessionListQuery): Promise<PageResponse<Session>> {
    const all = await this.bridge.rpc.listSessions({});
    // Sort by createdAt desc per REST §1.6 "最近 N 条（按 created_at desc）".
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);

    // Cursor: anchor on id. before_id = older than that id; after_id = newer.
    // Because the underlying list is desc, "older" = AFTER in the array.
    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.after_id);
    }

    let slice: typeof sorted;
    if (query.before_id !== undefined && pivotIndex >= 0) {
      // before_id = older entries → tail of the desc array, exclusive of pivot
      slice = sorted.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      // after_id = newer entries → head of the desc array, exclusive of pivot
      slice = sorted.slice(0, pivotIndex);
    } else {
      slice = sorted;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    // Hydrate each summary with its metadata. We do these in parallel —
    // `getSessionMetadata` is in-memory once the session is loaded, so the
    // round-trip count is what matters, not bandwidth.
    const items = await Promise.all(
      pageSummaries.map(async (s) => toProtocolSession(s, await this.tryGetMeta(s.id))),
    );

    // Apply post-hydration status filter if requested. Today all sessions
    // are mapped to 'idle' (see header note); the filter is wired now so the
    // wire contract is stable when agent-core surfaces a real status enum.
    const filtered =
      query.status !== undefined ? items.filter((s) => s.status === query.status) : items;

    return { items: filtered, has_more: hasMore };
  }

  async get(id: string): Promise<Session> {
    const all = await this.bridge.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    const meta = await this.tryGetMeta(id);
    return toProtocolSession(summary, meta);
  }

  async update(id: string, input: SessionUpdate): Promise<Session> {
    // Existence check first — gives a deterministic 40401 if the id is wrong.
    const all = await this.bridge.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    // 1) title goes through renameSession.
    if (input.title !== undefined) {
      await this.bridge.rpc.renameSession({ sessionId: id, title: input.title });
    }

    // 2) metadata patches go through updateSessionMetadata. agent-core's
    //    SessionMeta has top-level `title` + `custom`; we route protocol's
    //    `metadata` (catchall) into `custom` so it round-trips on the next get.
    const metadataPatch = input.metadata;
    if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
      await this.bridge.rpc.updateSessionMetadata({
        sessionId: id,
        metadata: { custom: metadataPatch as Record<string, unknown> },
      });
    }

    // 3) agent_config + permission_rules: no CoreAPI surface yet — we accept
    //    the input (schema-validated) but the daemon doesn't persist them
    //    in this chain. W7+ wires this. Documented in W6 STATUS.

    // Re-fetch to return the post-update Session.
    const allAfter = await this.bridge.rpc.listSessions({});
    const summaryAfter = allAfter.find((s) => s.id === id) ?? summary;
    const meta = await this.tryGetMeta(id);
    return toProtocolSession(summaryAfter, meta);
  }

  async delete(id: string): Promise<{ deleted: true }> {
    // Existence check — deterministic 40401 even on close.
    const all = await this.bridge.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    await this.bridge.rpc.closeSession({ sessionId: id });
    return { deleted: true };
  }

  /**
   * Pull a session's metadata; swallow errors (session may not be loaded into
   * the active session map yet, in which case `sessionApi(id)` throws). The
   * caller falls back to defaults from the summary alone.
   */
  private async tryGetMeta(id: string): Promise<SessionMeta | undefined> {
    try {
      const meta = await this.bridge.rpc.getSessionMetadata({ sessionId: id });
      return meta;
    } catch {
      return undefined;
    }
  }
}
