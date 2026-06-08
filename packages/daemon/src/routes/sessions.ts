/**
 * `/sessions/*` REST routes.
 *
 * 5 endpoints (REST.md §3.3):
 *
 *   POST   /sessions               body: SessionCreate    data: Session
 *   GET    /sessions               query: ListSessions    data: Page<Session>
 *   GET    /sessions/{id}          -                      data: Session
 *   PATCH  /sessions/{id}          body: SessionUpdate    data: Session
 *   DELETE /sessions/{id}          -                      data: { deleted: true }
 *
 * Each handler validates input with the Zod `validateBody` / `validateQuery`
 * preHandler (40001 on failure with `details` path), invokes
 * `accessor.get(ISessionService).<method>(...)`, and emits an `okEnvelope`.
 *
 * **Error mapping**: `SessionNotFoundError` → envelope `code: 40401`. Other
 * errors fall through to the global `installErrorHandler` (→ 50001).
 *
 * **Wiring**: takes an `IInstantiationService` so each request can resolve
 * `ISessionService` via the same DI container the daemon constructs in
 * `start.ts`. The handler closures don't capture the service directly — that
 * would break the per-request request_id flow and the dispose-cascade story.
 *
 * **Anti-corruption**: this file is part of `packages/daemon/src/`. No direct
 * SDK package imports — sessions go through `accessor.get(ISessionService)`
 * whose impl lives in `@moonshot-ai/services`.
 */

import {
  ErrorCode,
  createSessionRequestSchema,
  deleteSessionResponseSchema,
  pageResponseSchema,
  sessionSchema,
  sessionStatusSchema,
  updateSessionRequestSchema,
  workspaceIdSchema,
  type SessionCreate,
  type SessionUpdate,
} from '@moonshot-ai/protocol';
import {
  ISessionService,
  SessionNotFoundError,
  type SessionListQuery,
} from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope.js';
import { buildRouteSchema } from '../middleware/schema.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import {
  IWorkspaceRegistry,
  WorkspaceNotFoundError,
} from '#/services/workspace';

/**
 * Per-request structural typing — we never need the full FastifyRequest type;
 * the fields below are the only ones the handlers touch.
 */
interface SessionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  // Fastify exposes `patch` and `delete` as instance methods.
  patch(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

// --- Query coercion ---------------------------------------------------------

/**
 * HTTP query strings arrive as `Record<string, string>`. The protocol's
 * `cursorQuerySchema` expects `page_size: number`. We coerce at the daemon
 * boundary so the protocol schema stays HTTP-agnostic (re-usable on the
 * client side where JSON-RPC payloads already carry typed numbers).
 *
 * `page_size` parses as a positive integer 1..100; anything else fails 40001.
 */
const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    status: sessionStatusSchema.optional(),
    /**
     * When set, the daemon resolves the workspace_id to its registered root
     * and forwards the root as `workDir` to `ISessionService.list()`. That
     * takes the agent-core readdir fast path under the wd-key bucket.
     */
    workspace_id: workspaceIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

// --- Params -----------------------------------------------------------------

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

// --- Registration -----------------------------------------------------------

export function registerSessionsRoutes(
  app: SessionRouteHost,
  ix: IInstantiationService,
): void {
  // POST /sessions ------------------------------------------------------
  app.post(
    '/sessions',
    {
      preHandler: [validateBody(createSessionRequestSchema)],
      schema: buildRouteSchema({
        description: 'Create a new session',
        tags: ['sessions'],
        body: createSessionRequestSchema,
        response: { 200: sessionSchema },
      }),
    },
    async (req, reply) => {
      try {
        const body = req.body as SessionCreate;
        // The protocol schema accepts either `workspace_id` or `metadata.cwd`
        // (or both). The route layer:
        //   1. requires at-least-one (→ 40001 if neither is set)
        //   2. resolves workspace_id → workspace.root via IWorkspaceRegistry
        //      and touches `last_opened_at` on that record
        //   3. if BOTH workspace_id + metadata.cwd are set, verifies they
        //      agree on the same root (→ 40001 mismatch)
        //   4. forwards a normalized `{title, metadata: {cwd, ...}, ...}` to
        //      `ISessionService.create` — the services layer does NOT learn
        //      about workspaces.
        const callerCwd = typeof body.metadata?.cwd === 'string' ? body.metadata.cwd : undefined;
        const workspaceId = body.workspace_id;
        if (workspaceId === undefined && callerCwd === undefined) {
          reply.send(
            buildValidationEnvelope(
              [
                {
                  path: 'metadata.cwd',
                  message: 'either workspace_id or metadata.cwd is required',
                },
              ],
              req.id,
            ),
          );
          return;
        }

        let normalized: SessionCreate;
        if (workspaceId !== undefined) {
          const registry = ix.invokeFunction((a) => a.get(IWorkspaceRegistry));
          let workspaceRoot: string;
          try {
            workspaceRoot = await registry.resolveRoot(workspaceId);
          } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
              reply.send(
                errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, err.message, req.id),
              );
              return;
            }
            throw err;
          }
          if (callerCwd !== undefined && callerCwd !== workspaceRoot) {
            reply.send(
              buildValidationEnvelope(
                [
                  {
                    path: 'metadata.cwd',
                    message: `metadata.cwd (${callerCwd}) must equal workspace root (${workspaceRoot})`,
                  },
                ],
                req.id,
              ),
            );
            return;
          }
          // Touch last_opened_at — same as POST /workspaces { root }.
          await registry.createOrTouch(workspaceRoot);
          const { workspace_id: _drop, ...rest } = body;
          const otherMetadata = body.metadata ?? { cwd: workspaceRoot };
          normalized = {
            ...rest,
            metadata: { ...otherMetadata, cwd: workspaceRoot },
          };
        } else {
          const { workspace_id: _drop, ...rest } = body;
          normalized = rest;
        }

        const session = await ix.invokeFunction((a) =>
          a.get(ISessionService).create(normalized),
        );
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // GET /sessions -------------------------------------------------------
  app.get(
    '/sessions',
    {
      preHandler: [validateQuery(sessionsListQueryCoercion)],
      schema: buildRouteSchema({
        description: 'List sessions',
        tags: ['sessions'],
        querystring: sessionsListQueryCoercion,
        response: { 200: pageResponseSchema(sessionSchema) },
      }),
    },
    async (req, reply) => {
      try {
        const raw = req.query as {
          before_id?: string;
          after_id?: string;
          page_size?: number;
          status?: import('@moonshot-ai/protocol').SessionStatus;
          workspace_id?: string;
        };
        let query: SessionListQuery;
        if (raw.workspace_id !== undefined) {
          const registry = ix.invokeFunction((a) => a.get(IWorkspaceRegistry));
          let root: string;
          try {
            root = await registry.resolveRoot(raw.workspace_id);
          } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
              reply.send(
                errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, err.message, req.id),
              );
              return;
            }
            throw err;
          }
          const { workspace_id: _drop, ...rest } = raw;
          query = { ...rest, workDir: root };
        } else {
          const { workspace_id: _drop, ...rest } = raw;
          query = rest;
        }
        const page = await ix.invokeFunction((a) => a.get(ISessionService).list(query));
        reply.send(okEnvelope(page, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // GET /sessions/{session_id} ------------------------------------------
  app.get(
    '/sessions/:session_id',
    {
      preHandler: [validateParams(sessionIdParamSchema)],
      schema: buildRouteSchema({
        description: 'Get a session by ID',
        tags: ['sessions'],
        params: sessionIdParamSchema,
        response: { 200: sessionSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params as { session_id: string };
        const session = await ix.invokeFunction((a) => a.get(ISessionService).get(session_id));
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // PATCH /sessions/{session_id} ----------------------------------------
  app.patch(
    '/sessions/:session_id',
    {
      preHandler: [
        validateParams(sessionIdParamSchema),
        validateBody(updateSessionRequestSchema),
      ],
      schema: buildRouteSchema({
        description: 'Update a session',
        tags: ['sessions'],
        params: sessionIdParamSchema,
        body: updateSessionRequestSchema,
        response: { 200: sessionSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params as { session_id: string };
        const body = req.body as SessionUpdate;
        const session = await ix.invokeFunction((a) =>
          a.get(ISessionService).update(session_id, body),
        );
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // DELETE /sessions/{session_id} ---------------------------------------
  app.delete(
    '/sessions/:session_id',
    {
      preHandler: [validateParams(sessionIdParamSchema)],
      schema: buildRouteSchema({
        description: 'Delete a session',
        tags: ['sessions'],
        params: sessionIdParamSchema,
        response: { 200: deleteSessionResponseSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params as { session_id: string };
        const result = await ix.invokeFunction((a) => a.get(ISessionService).delete(session_id));
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
}

/**
 * Map a thrown error to the right envelope:
 *   - `SessionNotFoundError` → `code: 40401`
 *   - `WorkspaceNotFoundError` → `code: 40410`
 *   - Anything else → re-throw so the global `installErrorHandler` catches it
 *     and emits `50001`.
 *
 * We don't catch generic `Error` here because the global hook is the single
 * place stack traces reach the operator log (`error-handler.ts:42-43`).
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof WorkspaceNotFoundError) {
    reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, err.message, requestId));
    return;
  }
  // Re-throw so Fastify's error hook handles it.
  throw err;
}

/**
 * Build a 40001 validation envelope inline (the daemon's middleware/validate.ts
 * helper isn't reachable from a handler — it lives behind a preHandler hook).
 * Used for at-least-one-of (`workspace_id` / `metadata.cwd`) + mismatch
 * checks the protocol schema can't express on its own.
 */
function buildValidationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg = first === undefined
    ? 'validation failed'
    : first.path === ''
      ? first.message
      : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}
