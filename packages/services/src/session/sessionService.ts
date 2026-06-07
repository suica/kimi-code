/**
 * `SessionService` — implementation of `ISessionService`.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type { JsonObject, SessionMeta, SessionSummary } from '@moonshot-ai/agent-core';
import {
  emptySessionUsage,
  type PageResponse,
  type Session,
  type SessionCreate,
  type SessionUpdate,
} from '@moonshot-ai/protocol';

import { IHarnessBridge } from '../bridge/harness-bridge';
import {
  ISessionService,
  SessionNotFoundError,
  toProtocolSession,
  type SessionListQuery,
} from './session';

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

export class SessionService extends Disposable implements ISessionService {
  readonly _serviceBrand: undefined;

  /** Handlers for session-created events. */
  private readonly _createHandlers = new Set<(e: { session: Session }) => void>();
  /** Handlers for session-closed events. */
  private readonly _closeHandlers = new Set<(e: { sessionId: string }) => void>();

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
    const session = toProtocolSession(summary, meta);
    // Fire onDidCreate handlers after bridge RPC resolves.
    for (const h of this._createHandlers) h({ session });
    return session;
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
    // Fire onDidClose handlers after bridge RPC resolves.
    for (const h of this._closeHandlers) h({ sessionId: id });
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

  // --- Per-domain event listeners -------------------------------------------

  onDidCreate(handler: (event: { session: Session }) => void): () => void {
    this._createHandlers.add(handler);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this._createHandlers.delete(handler);
    };
  }

  onDidClose(handler: (event: { sessionId: string }) => void): () => void {
    this._closeHandlers.add(handler);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this._closeHandlers.delete(handler);
    };
  }

  override dispose(): void {
    if (this._isDisposed) return;
    this._createHandlers.clear();
    this._closeHandlers.clear();
    super.dispose();
  }
}
