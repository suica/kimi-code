/**
 * `SessionService` — implementation of `ISessionService`.
 */

import {
  Disposable,
  Emitter,
  registerSingleton,
  SyncDescriptor,
} from '@moonshot-ai/agent-core';
import type { JsonObject, SessionMeta, SessionSummary } from '@moonshot-ai/agent-core';
import {
  emptySessionUsage,
  type PageResponse,
  type Session,
  type SessionCreate,
  type SessionUpdate,
} from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
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

  /**
   * VSCode-style Emitter for session-creation events. Listener exceptions
   * route to `onUnexpectedError` inside `Emitter.fire()`. Owned via
   * `_register(...)` so it disposes when the service is torn down.
   */
  private readonly _onDidCreate = this._register(new Emitter<{ session: Session }>());
  readonly onDidCreate = this._onDidCreate.event;
  /**
   * VSCode-style Emitter for session-close events. Same ownership +
   * exception-routing semantics as `_onDidCreate`.
   */
  private readonly _onDidClose = this._register(new Emitter<{ sessionId: string }>());
  readonly onDidClose = this._onDidClose.event;

  constructor(@ICoreProcessService private readonly core: ICoreProcessService) {
    super();
  }

  async create(input: SessionCreate): Promise<Session> {
    // SessionCreate.metadata.cwd is REQUIRED by Zod; agent-core's createSession
    // also calls `requiredWorkDir(...)` which throws if missing.
    const metadataForCore = asJsonObject(input.metadata as Record<string, unknown>);
    const summary = await this.core.rpc.createSession({
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
        await this.core.rpc.renameSession({ sessionId: summary.id, title: input.title });
      } catch {
        // If rename fails (e.g. session closed/race), continue with the
        // default — the response shape is unchanged.
      }
    }
    const meta = await this.tryGetMeta(summary.id);
    const session = toProtocolSession(summary, meta);
    // Fire onDidCreate listeners after the core RPC resolves.
    this._onDidCreate.fire({ session });
    return session;
  }

  async list(query: SessionListQuery): Promise<PageResponse<Session>> {
    const all = await this.core.rpc.listSessions({});
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
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    const meta = await this.tryGetMeta(id);
    return toProtocolSession(summary, meta);
  }

  async update(id: string, input: SessionUpdate): Promise<Session> {
    // Existence check first — gives a deterministic 40401 if the id is wrong.
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    // 1) title goes through renameSession.
    if (input.title !== undefined) {
      await this.core.rpc.renameSession({ sessionId: id, title: input.title });
    }

    // 2) metadata patches go through updateSessionMetadata. agent-core's
    //    SessionMeta has top-level `title` + `custom`; we route protocol's
    //    `metadata` (catchall) into `custom` so it round-trips on the next get.
    const metadataPatch = input.metadata;
    if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
      await this.core.rpc.updateSessionMetadata({
        sessionId: id,
        metadata: { custom: metadataPatch as Record<string, unknown> },
      });
    }

    // 3) agent_config + permission_rules: no CoreAPI surface yet — we accept
    //    the input (schema-validated) but no CoreAPI surface exists to persist
    //    them yet.

    // Re-fetch to return the post-update Session.
    const allAfter = await this.core.rpc.listSessions({});
    const summaryAfter = allAfter.find((s) => s.id === id) ?? summary;
    const meta = await this.tryGetMeta(id);
    return toProtocolSession(summaryAfter, meta);
  }

  async delete(id: string): Promise<{ deleted: true }> {
    // Existence check — deterministic 40401 even on close.
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    await this.core.rpc.closeSession({ sessionId: id });
    // Fire onDidClose listeners after the core RPC resolves.
    this._onDidClose.fire({ sessionId: id });
    return { deleted: true };
  }

  /**
   * Pull a session's metadata; swallow errors (session may not be loaded into
   * the active session map yet, in which case `sessionApi(id)` throws). The
   * caller falls back to defaults from the summary alone.
   */
  private async tryGetMeta(id: string): Promise<SessionMeta | undefined> {
    try {
      const meta = await this.core.rpc.getSessionMetadata({ sessionId: id });
      return meta;
    } catch {
      return undefined;
    }
  }

  // --- Per-domain event accessors -------------------------------------------
  //
  // `onDidCreate` / `onDidClose` are declared above as
  // `Emitter<T>.event` getters; consumers subscribe via
  // `svc.onDidCreate(handler)` (returns IDisposable) and own the
  // detach lifetime through `Disposable._register(...)`.

  override dispose(): void {
    if (this._isDisposed) return;
    // `_onDidCreate` and `_onDidClose` are registered via `this._register(...)`,
    // so `super.dispose()` flushes their listeners.
    super.dispose();
  }
}

// Self-register under the global singleton registry. Daemon-side bootstrap
// projects this through `defaultServicesModule()` /
// `getSingletonServiceDescriptors()`. All ctor deps are `@I…`-injected, so
// `staticArguments` is `[]`. `supportsDelayedInstantiation = false` preserves
// current reverse-dispose semantics.
registerSingleton(ISessionService, new SyncDescriptor(SessionService, [], false));
