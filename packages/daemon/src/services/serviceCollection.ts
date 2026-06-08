/**
 * `createDaemonServiceCollection` (Phase 4 Step 4.2) — central wiring for
 * the daemon's DI graph. Mirrors the VSCode `electron-main/main.ts:162-233`
 * pattern: hybrid `ServiceCollection`, with:
 *
 *   - **Prebuilt** `services.set(I, new C(...))` for services that capture
 *     runtime handles or closures the container can't synthesize
 *     (`PinoLogger` wraps the Fastify-shared `pino.Logger`;
 *     `FastifyRestGateway` wraps the `FastifyLike` instance;
 *     `IEnvironmentService` carries CLI-resolved `homeDir` / `configPath`).
 *   - **Descriptor** `services.set(I, new SyncDescriptor(C, [options], false))`
 *     for services whose ctor signature is `(options, @I*...)` with options
 *     as a pure data bag. The container drives construction via
 *     `_createAndCacheServiceInstance` so `@I*` decorators auto-inject.
 *
 * `supportsDelayedInstantiation = false` for every descriptor here —
 * plan §4.1 keeps the entire first round eager to preserve the
 * `_constructionOrder` discipline that powers reverse-dispose order. The
 * `a.get(IX)` touch sequence in `start.ts` still pins the ordering.
 *
 * # Why a helper (not inline in start.ts)?
 *
 * Phase 4 plan §2.2: "centralize all `services.set(... new SyncDescriptor(...))`
 * in one place" — keeps the wiring shape auditable in a single file while
 * `start.ts` retains the construction-order touch list + post-collection
 * adapters (`IEventReplayService` alias, `IFsWatcher` closure construction,
 * `setUnexpectedErrorHandler`, WS abort + fs-watch handler wiring).
 *
 * # Why `IFsWatcher` stays in start.ts
 *
 * `FsWatcherService` ctor takes a `connection-lookup` closure built from
 * `IConnectionRegistry.get` at runtime. That closure isn't serializable
 * into a `SyncDescriptor` static-arg slot, so we keep its construction
 * inside the `ix.invokeFunction` block in `start.ts` post-collection.
 * This is the one documented exception per plan §2.2.
 *
 * # Why `IEventReplayService` stays in start.ts
 *
 * It's an **alias** — same singleton as `IEventService`, registered under
 * a different decorator so `WSGateway` can `@IEventReplayService` without
 * importing the concrete `EventService` class. The alias must be set
 * AFTER the first `a.get(IEventService)` so the container has the live
 * bus instance. That post-construction wiring stays in start.ts.
 */

import {
  ServiceCollection,
  SyncDescriptor,
} from '@moonshot-ai/agent-core';
import {
  AuthSummaryService,
  CoreProcessService,
  IApprovalService,
  IAuthSummaryService,
  IEnvironmentService,
  IEventService,
  ICoreProcessService,
  IMcpService,
  IMessageService,
  IOAuthService,
  IPromptService,
  IQuestionService,
  ISessionService,
  ITaskService,
  IToolService,
  McpService,
  MessageService,
  OAuthService,
  PromptService,
  SessionService,
  TaskService,
  ToolService,
} from '@moonshot-ai/services';
import type { Logger as PinoLogger } from 'pino';

import type { FastifyLike } from './restGateway.js';
import type { DaemonStartOptions } from '../start.js';

import { ApprovalService } from './approvalService.js';
import { IConnectionRegistry } from './connectionRegistry.js';
import { ConnectionRegistry } from './connectionRegistryService.js';
import { EventService } from './eventService.js';
import { IFsService } from './fs.js';
import { FsService } from './fsService.js';
import { IFsGitService } from './fsGit.js';
import { FsGitService } from './fsGitService.js';
import { IFsSearchService } from './fsSearch.js';
import { FsSearchService } from './fsSearchService.js';
import { IFileStore } from './fileStore.js';
import { FileStore } from './fileStoreService.js';
import { ILogger } from './logger.js';
import { PinoLogger as PinoLoggerAdapter } from './loggerService.js';
import { QuestionService } from './questionService.js';
import { IRestGateway } from './restGateway.js';
import { FastifyRestGateway } from './restGatewayService.js';
import { ISessionClientsService } from './sessionClients.js';
import { SessionClientsService } from './sessionClientsService.js';
import { IWSGateway } from './wsGateway.js';
import { WSGateway } from './wsGatewayService.js';

export interface DaemonServiceCollectionOptions {
  /** Original `startDaemon` options bag — carries the per-service tunables. */
  readonly daemon: DaemonStartOptions;
  /** Resolved Fastify instance (`app`) — needed by `FastifyRestGateway`. */
  readonly app: FastifyLike;
  /** Fastify-shared pino logger — wrapped by `PinoLoggerAdapter`. */
  readonly pinoLogger: PinoLogger;
  /** Pre-resolved environment paths (homeDir / configPath). */
  readonly envService: IEnvironmentService;
}

/**
 * Assemble the daemon's `ServiceCollection`. The returned collection has
 * EVERY singleton seeded — either as a prebuilt instance (runtime-handle
 * services) or as a `SyncDescriptor` (descriptor-first singletons).
 *
 * Two singletons NOT registered here, by design:
 *   - `IEventReplayService` — same instance as `IEventService`; aliased
 *     post-construction in `start.ts` (see file header).
 *   - `IFsWatcher` — needs a closure over `IConnectionRegistry.get` at
 *     construction time; built inline in `start.ts` (see file header).
 */
export function createDaemonServiceCollection(
  input: DaemonServiceCollectionOptions,
): ServiceCollection {
  const { daemon, app, pinoLogger, envService } = input;

  const services = new ServiceCollection();

  // -- Prebuilt: services that need runtime handles / external closures ------
  //
  // These are VSCode-`electron-main/main.ts:162-233`-style seedings: the
  // ctor takes a non-serializable handle (the pino logger; the Fastify
  // instance; the CLI-resolved path object) so the container can't drive
  // construction.
  services.set(ILogger, new PinoLoggerAdapter(pinoLogger));
  services.set(IRestGateway, new FastifyRestGateway(app));
  services.set(IEnvironmentService, envService);

  // -- Descriptor: pure `@I*` injection + options as data bag ---------------
  //
  // Order in this list is NOT load-bearing. The construction order is
  // pinned by the `a.get(IX)` touch sequence in `start.ts`'s
  // `ix.invokeFunction` block. Grouping here mirrors the chain markers
  // (W5.x / P2.x) used in start.ts for cross-reference.
  services.set(IConnectionRegistry, new SyncDescriptor(ConnectionRegistry, [], false));
  services.set(ISessionClientsService, new SyncDescriptor(SessionClientsService, [], false));
  services.set(IEventService, new SyncDescriptor(EventService, [{}], false));
  services.set(IApprovalService, new SyncDescriptor(ApprovalService, [{}], false));
  services.set(IQuestionService, new SyncDescriptor(QuestionService, [{}], false));
  services.set(
    IWSGateway,
    new SyncDescriptor(WSGateway, [daemon.wsGatewayOptions ?? {}], false),
  );
  services.set(
    ICoreProcessService,
    new SyncDescriptor(CoreProcessService, [daemon.coreProcessOptions ?? {}], false),
  );
  services.set(ISessionService, new SyncDescriptor(SessionService, [], false));
  services.set(IMessageService, new SyncDescriptor(MessageService, [], false));
  services.set(IAuthSummaryService, new SyncDescriptor(AuthSummaryService, [], false));
  services.set(IOAuthService, new SyncDescriptor(OAuthService, [], false));
  services.set(IPromptService, new SyncDescriptor(PromptService, [], false));
  services.set(IToolService, new SyncDescriptor(ToolService, [], false));
  services.set(IMcpService, new SyncDescriptor(McpService, [], false));
  services.set(ITaskService, new SyncDescriptor(TaskService, [], false));
  services.set(IFsService, new SyncDescriptor(FsService, [], false));
  services.set(IFsSearchService, new SyncDescriptor(FsSearchService, [], false));
  services.set(IFsGitService, new SyncDescriptor(FsGitService, [], false));

  // `IFileStore` carries `homeDir` resolution. Prefer the explicit
  // override (tests set this); fall back to the default (resolved
  // internally by FileStore against `resolveKimiHome()` when `homeDir`
  // is undefined).
  const fileStoreHomeDir = daemon.coreProcessOptions?.homeDir;
  services.set(
    IFileStore,
    new SyncDescriptor(
      FileStore,
      [fileStoreHomeDir !== undefined ? { homeDir: fileStoreHomeDir } : {}],
      false,
    ),
  );

  return services;
}
