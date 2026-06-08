/**
 * `/workspaces/*` REST routes.
 *
 * 4 endpoints:
 *
 *   GET    /workspaces                                  → { items }
 *   POST   /workspaces      body: WorkspaceCreate       → Workspace (idempotent)
 *   PATCH  /workspaces/{workspace_id}   body: { name }  → Workspace
 *   DELETE /workspaces/{workspace_id}                   → { deleted: true }
 *
 * **Idempotent POST**: same `root` (post-realpath) always yields the same
 * `wd_<slug>_<hash12>` id; daemon touches `last_opened_at` on existing
 * records and returns the same Workspace. There is no separate
 * `409 already_exists` path — the wire is one of "ok with fresh-mint" or
 * "ok with touch". Callers don't need to distinguish.
 *
 * **Error mapping**:
 *   - `WorkspaceNotFoundError`         → envelope `code: 40410`
 *   - `WorkspaceRootNotFoundError`     → envelope `code: 40409`
 *   - other errors                     → global hook (→ 50001)
 *
 * **Anti-corruption**: zero SDK imports; workspaces are a pure daemon-OWN
 * concept (no agent-core surface).
 */

import {
  ErrorCode,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  deleteWorkspaceResponseSchema,
  listWorkspacesResponseSchema,
  updateWorkspaceRequestSchema,
  updateWorkspaceResponseSchema,
  workspaceIdParamSchema,
  type CreateWorkspaceRequest,
  type UpdateWorkspaceRequest,
} from '@moonshot-ai/protocol';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope.js';
import { buildRouteSchema } from '../middleware/schema.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  IWorkspaceRegistry,
  WorkspaceNotFoundError,
  WorkspaceRootNotFoundError,
} from '#/services/workspace';

interface WorkspaceRouteHost {
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
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
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

export function registerWorkspacesRoutes(
  app: WorkspaceRouteHost,
  ix: IInstantiationService,
): void {
  // GET /workspaces -----------------------------------------------------
  app.get(
    '/workspaces',
    {
      preHandler: [],
      schema: buildRouteSchema({
        description: 'List registered workspaces',
        tags: ['workspaces'],
        response: { 200: listWorkspacesResponseSchema },
      }),
    },
    async (req, reply) => {
      try {
        const items = await ix.invokeFunction((a) => a.get(IWorkspaceRegistry).list());
        reply.send(okEnvelope({ items }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // POST /workspaces ----------------------------------------------------
  app.post(
    '/workspaces',
    {
      preHandler: [validateBody(createWorkspaceRequestSchema)],
      schema: buildRouteSchema({
        description: 'Register a workspace (idempotent on root)',
        tags: ['workspaces'],
        body: createWorkspaceRequestSchema,
        response: { 200: createWorkspaceResponseSchema },
      }),
    },
    async (req, reply) => {
      try {
        const body = req.body as CreateWorkspaceRequest;
        const ws = await ix.invokeFunction((a) =>
          a.get(IWorkspaceRegistry).createOrTouch(body.root, body.name),
        );
        reply.send(okEnvelope(ws, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // PATCH /workspaces/{workspace_id} ------------------------------------
  app.patch(
    '/workspaces/:workspace_id',
    {
      preHandler: [
        validateParams(workspaceIdParamSchema),
        validateBody(updateWorkspaceRequestSchema),
      ],
      schema: buildRouteSchema({
        description: 'Rename a workspace (display name only)',
        tags: ['workspaces'],
        params: workspaceIdParamSchema,
        body: updateWorkspaceRequestSchema,
        response: { 200: updateWorkspaceResponseSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { workspace_id } = req.params as { workspace_id: string };
        const body = req.body as UpdateWorkspaceRequest;
        const ws = await ix.invokeFunction((a) =>
          a.get(IWorkspaceRegistry).update(workspace_id, { name: body.name }),
        );
        reply.send(okEnvelope(ws, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // DELETE /workspaces/{workspace_id} -----------------------------------
  app.delete(
    '/workspaces/:workspace_id',
    {
      preHandler: [validateParams(workspaceIdParamSchema)],
      schema: buildRouteSchema({
        description: 'Unregister a workspace (does not remove on-disk content)',
        tags: ['workspaces'],
        params: workspaceIdParamSchema,
        response: { 200: deleteWorkspaceResponseSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { workspace_id } = req.params as { workspace_id: string };
        await ix.invokeFunction((a) => a.get(IWorkspaceRegistry).delete(workspace_id));
        reply.send(okEnvelope({ deleted: true as const }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof WorkspaceNotFoundError) {
    reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof WorkspaceRootNotFoundError) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId));
    return;
  }
  throw err;
}
