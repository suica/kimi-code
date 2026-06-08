import {
  InstantiationService,
  resolveConfigPath,
  resolveKimiHome,
  setUnexpectedErrorHandler,
} from '@moonshot-ai/agent-core';
import {
  IApprovalService,
  IAuthSummaryService,
  IEnvironmentService,
  IEventReplayService,
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
  SessionNotFoundError,
  type CoreProcessServiceOptions,
} from '@moonshot-ai/services';
import { ErrorCode } from '@moonshot-ai/protocol';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ulid } from 'ulid';
import { promises as fspPromises } from 'node:fs';
import { sep as nodePathSep, relative as nodePathRelativeNative } from 'node:path';

import { okEnvelope } from './envelope.js';
import { installErrorHandler } from './error-handler.js';
import { acquireLock, DaemonLockedError } from './lock.js';
import { createDaemonLogger, type DaemonLogLevel, type DaemonLogger } from './logger.js';
import { resolveRequestId } from './request-id.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerFilesRoutes } from './routes/files.js';
import { registerMessagesRoutes } from './routes/messages.js';
import { registerMetaRoute } from './routes/meta.js';
import { registerPromptsRoutes } from './routes/prompts.js';
import { registerApprovalsRoutes } from './routes/approvals.js';
import { registerAuthRoute } from './routes/auth.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerQuestionsRoutes } from './routes/questions.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerTasksRoutes } from './routes/tasks.js';
import { registerToolsRoutes } from './routes/tools.js';
import { IConnectionRegistry } from './services/connection-registry.js';
import { type EventService } from './services/eventService.js';
import { IFsService } from './services/fs.js';
import { IFsGitService } from './services/fs-git.js';
import { IFsSearchService } from './services/fs-search.js';
import {
  IFsWatcher,
  FsWatchLimitError,
  createConnectionLookup,
} from './services/fs-watcher.js';
import { FsWatcherService } from './services/fsWatcherService.js';
import { FsPathEscapesError, resolveSafePath } from './services/fs-path-safety.js';
import { IFileStore } from './services/file-store.js';
import { ILogger } from './services/logger.js';
import { IRestGateway } from './services/rest-gateway.js';
import { ISessionClientsService } from './services/session-clients.js';
import { createDaemonServiceCollection } from './services/serviceCollection.js';
import { IWSGateway, type WSGatewayOptions } from './services/ws-gateway.js';
import { getDaemonVersion } from './version.js';

export interface DaemonStartOptions {
  host: string;
  port: number;
  logLevel?: DaemonLogLevel;
  /** Provide an external logger instead of constructing one. */
  logger?: DaemonLogger;
  /**
   * Override the default lock file path (`~/.kimi/daemon/lock`). Tests use
   * this to point at a tmpdir; production callers leave it undefined.
   */
  lockPath?: string;
  /**
   * Optional `CoreProcessServiceOptions` passthrough — extends `KimiCoreOptions`
   * (homeDir, etc.). Tests use this to isolate KimiCore's `~/.kimi` lookup.
   */
  coreProcessOptions?: CoreProcessServiceOptions;
  /**
   * W5.1: optional WS gateway tunables for tests (`pingIntervalMs`, etc.).
   * Production callers leave this undefined and pick up the WS.md §1.3 / §3.1
   * defaults (30s ping, 10s pong deadline, 1000-event ring buffer).
   */
  wsGatewayOptions?: WSGatewayOptions;
}

export interface RunningDaemon {
  /** Resolved listening address, useful when port=0. */
  readonly address: string;
  /** Logger shared with Fastify; use this for daemon-level events. */
  readonly logger: DaemonLogger;
  /**
   * The DI container — exposed for tests and W5+ external consumers. The
   * container holds the bridge, brokers, and gateway. `close()` disposes it.
   */
  readonly services: InstantiationService;
  /** Stop the listener, dispose the container, release the lock; idempotent. */
  close(): Promise<void>;
}

/** Re-export so CLI / tests can `catch` against the specific lock-conflict type. */
export { DaemonLockedError };

/**
 * Boot the daemon (W4.4 / P0.14, extended in W5.1+W5.2 / P0.15+P0.16): lock
 * → Fastify → `app.ready()` → DI container → services → bridge.ready → listen.
 *
 * **Wiring order matters for teardown** (W3 handoff §Gotchas):
 *   construction order = [ILogger, IRestGateway, IConnectionRegistry,
 *                          ISessionClientsService, IEventService, IApprovalService,
 *                          IQuestionService, IWSGateway, ICoreProcessService]
 *   dispose order      = REVERSE of the above (per InstantiationService
 *                        `_constructionOrder` semantics).
 *
 * So at shutdown: CoreProcessService → WSGateway (closes WS conns via the
 * registry) → brokers (Question, Approval, EventBus) → SessionClients →
 * ConnectionRegistry (no-op — gateway already drained it) → RestGateway →
 * Logger. The logger disposing last is critical — every other service's
 * `dispose()` may emit a log line. WSGateway disposing EARLY means brokers
 * never emit into closed sockets; SessionClients dropping AFTER EventBus
 * means the bus has stopped publishing before its subscriber index goes
 * away.
 *
 * **CoreProcessService construction** (Phase 4 descriptor-first): every
 * non-runtime-handle singleton (including `ICoreProcessService`) is now
 * a `SyncDescriptor` in `createDaemonServiceCollection()`, with options
 * baked into the descriptor's `staticArguments`. The first
 * `a.get(ICoreProcessService)` call below resolves the descriptor with
 * `opts.coreProcessOptions ?? {}` already bound; no inline
 * `ix.createInstance(CoreProcessService, ...)` is needed.
 *
 * **Post-Phase-4 wire-up shape**: the `invokeFunction` block below is
 * effectively a sequence of `a.get(IFoo)` "touch" calls that pin
 * construction order for `_constructionOrder`. The two remaining
 * non-`a.get` wirings are:
 *
 *   1. The `services.set(IEventReplayService, eventBus)` alias —
 *      same singleton as `IEventService` under a different decorator
 *      so `@IEventReplayService` consumers (e.g. `WSGateway`) resolve
 *      against the live bus.
 *   2. The inline `ix.createInstance(FsWatcherService, lookup, {})` —
 *      its `lookup` closure over `IConnectionRegistry.get` isn't
 *      serializable into a `SyncDescriptor.staticArguments` slot.
 *
 * Both exceptions are documented near their construction sites and in
 * `services/serviceCollection.ts` header.
 *
 * **Anti-corruption invariant**: daemon source has zero direct SDK
 * (`packages/node-sdk`) imports — the bridge is the only path to
 * KimiCore, and we get it via `@moonshot-ai/services` re-exports.
 */
export async function startDaemon(opts: DaemonStartOptions): Promise<RunningDaemon> {
  const pinoLogger: DaemonLogger =
    opts.logger ?? createDaemonLogger({ level: opts.logLevel ?? 'info' });

  // Lock FIRST — if another daemon is alive we fail before reserving the port.
  const lockHandle = acquireLock({ port: opts.port, lockPath: opts.lockPath });

  const app = Fastify({
    loggerInstance: pinoLogger,
    disableRequestLogging: false,
    genReqId: (req) => resolveRequestId(req.headers),
  });
  installErrorHandler(app);

  // Register @fastify/swagger BEFORE routes so it can collect schema
  // metadata via the `onRoute` hook.
  const daemonVersion = getDaemonVersion();
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Kimi Code Daemon API',
        description:
          'REST API for the Kimi Code local daemon. All JSON responses are wrapped in a uniform envelope `{ code, msg, data, request_id }`.',
        version: daemonVersion,
      },
      tags: [
        { name: 'meta', description: 'Daemon metadata' },
        { name: 'auth', description: 'Auth readiness & login state' },
        { name: 'sessions', description: 'Session lifecycle' },
        { name: 'messages', description: 'Message history' },
        { name: 'prompts', description: 'Prompt submission & abort' },
        { name: 'approvals', description: 'Approval resolution' },
        { name: 'questions', description: 'Question resolution & dismiss' },
        { name: 'tools', description: 'Tool & MCP server management' },
        { name: 'tasks', description: 'Background tasks' },
        { name: 'fs', description: 'Filesystem operations' },
        { name: 'files', description: 'File upload & download' },
      ],
    },
  });

  // Seed the container. Per Phase 4 §2.2 the collection is now a HYBRID:
  //   - prebuilt instance for services that carry runtime handles (PinoLogger
  //     wraps Fastify's shared `pino.Logger`; FastifyRestGateway wraps `app`;
  //     `IEnvironmentService` carries CLI-resolved paths);
  //   - SyncDescriptor for every other singleton (container drives
  //     construction; `@I*` decorators auto-inject).
  //
  // Two singletons are NOT in `createDaemonServiceCollection()`, by design:
  //   - IEventReplayService — alias of the same EventService singleton;
  //     registered AFTER `a.get(IEventService)` resolves the live bus.
  //   - IFsWatcher — needs a closure over `IConnectionRegistry.get`;
  //     built inline inside the `invokeFunction` block below.
  //
  // The construction order recorded in `_constructionOrder` (which drives
  // reverse-dispose) is pinned by the `a.get(IX)` touch sequence below,
  // NOT by the order singletons appear in `createDaemonServiceCollection()`.
  //
  // We construct the container BEFORE `app.ready()` so route modules can
  // capture `ix` by reference and resolve services at REQUEST time. Fastify
  // locks new route registration after `app.ready()`, so any module that
  // needs to `app.post(...)` etc. must register before the ready gate. The
  // service graph is filled in immediately below — completed BEFORE the
  // first request can land (we still `await app.ready()`, then `bridge.ready()`,
  // then `IRestGateway.listen()`).
  const envService: IEnvironmentService = {
    _serviceBrand: undefined,
    homeDir: resolveKimiHome(opts.coreProcessOptions?.homeDir),
    configPath: resolveConfigPath({
      homeDir: opts.coreProcessOptions?.homeDir,
      configPath: opts.coreProcessOptions?.configPath,
    }),
  };

  const services = createDaemonServiceCollection({
    daemon: opts,
    app,
    pinoLogger,
    envService,
  });
  const ix = new InstantiationService(services);

  // Register all REST routes under a single `/api/v1` prefix so individual
  // route modules don't hardcode the version segment.
  await app.register(async (apiV1) => {
    apiV1.get('/healthz', {
      schema: {
        description: 'Health check',
        response: {
          200: {
            type: 'object',
            properties: {
              code: { type: 'number' },
              msg: { type: 'string' },
              data: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
              },
              request_id: { type: 'string' },
            },
          },
        },
      },
    }, async (req, reply) => {
      return reply.send(okEnvelope({ ok: true }, req.id));
    });

    // W6.1 / Chain 1 — `/meta`. Pure daemon-self info, no DI needed. Mint
    // the per-process server_id + boot timestamp once at registration time
    // (ROADMAP P1.1; REST.md §3.1).
    const serverId = ulid();
    const startedAt = new Date().toISOString();
    registerMetaRoute(apiV1, {
      daemonVersion,
      serverId,
      startedAt,
    });

    // P2.1 / Chain P2.1.1 — `GET /auth`. Readiness probe + onboarding gate
    // signal. No body, no auth, always 200. Wired AFTER meta so reverse-
    // dispose order matters not (route registrations are not stateful).
    registerAuthRoute(apiV1 as unknown as Parameters<typeof registerAuthRoute>[0], ix);

    // P2.7 / Chain P2.7.1 — `/oauth/*`. Device-code flow start / poll /
    // cancel + logout. Grouped under the `auth` swagger tag since they're
    // all login-related; the URL prefix `/oauth` keeps them out of
    // `/auth`'s pure-readout namespace.
    registerOAuthRoutes(apiV1 as unknown as Parameters<typeof registerOAuthRoutes>[0], ix);

    // W6.2 / Chain 2 — register `/sessions/*` routes. The route module
    // captures `ix` by reference; per-request `accessor.get(ISessionService)`
    // dispatches against whatever's in the container at that moment. We
    // populate ISessionService below; by the time the first request lands the
    // container is fully wired (we await app.ready() + bridge.ready() before
    // listen() opens the socket).
    registerSessionsRoutes(apiV1 as unknown as Parameters<typeof registerSessionsRoutes>[0], ix);
    // W7.1 / Chain 3 — register `/sessions/{sid}/messages*` routes. Same
    // wiring story: handlers resolve `IMessageService` per-request through ix.
    registerMessagesRoutes(apiV1 as unknown as Parameters<typeof registerMessagesRoutes>[0], ix);
    // W7.2 / Chain 4 — register `/sessions/{sid}/prompts*` routes (submit +
    // abort). Submit triggers `bridge.rpc.prompt(...)` whose synchronous event
    // stream lands on `IEventService → WS broadcast`. Abort is the REST fallback
    // for the WS abort message handled at `ws/connection.ts` (Chain 4b / W7.3).
    registerPromptsRoutes(apiV1 as unknown as Parameters<typeof registerPromptsRoutes>[0], ix);
    // W8.1 / Chain 5 — register `/sessions/{sid}/approvals/{aid}` route.
    // The reverse-RPC path: agent-core → bridge → ApprovalService → WS
    // `event.approval.requested`. The REST handler completes the round-trip
    // by calling `IApprovalService.resolve(aid, body)`.
    registerApprovalsRoutes(
      apiV1 as unknown as Parameters<typeof registerApprovalsRoutes>[0],
      ix,
    );
    // W8.2 / Chain 6 — register `/sessions/{sid}/questions/{qid}*` routes.
    // Same reverse-RPC pattern as approval, with first-class `:dismiss`
    // (SCHEMAS §6.3) and 5-kind discriminated-union answer normalization
    // (SCHEMAS §6.4) done by the services adapter at REST-boundary time.
    registerQuestionsRoutes(
      apiV1 as unknown as Parameters<typeof registerQuestionsRoutes>[0],
      ix,
    );
    // W9.1 / Chain 7 — register `/tools` + `/mcp/servers*` routes.
    // Read-only `getTools` + `listMcpServers` plus `:restart` action — the 4th
    // call site of the `:tail` action-suffix pattern, now extracted into
    // `routes/action-suffix.ts`.
    registerToolsRoutes(
      apiV1 as unknown as Parameters<typeof registerToolsRoutes>[0],
      ix,
    );
    // W9.2 / Chain 8 — register `/sessions/{sid}/tasks*` routes.
    // list/get/cancel with 40406 + 40904 + the 5th `:tail` (action :cancel).
    registerTasksRoutes(
      apiV1 as unknown as Parameters<typeof registerTasksRoutes>[0],
      ix,
    );
    // W10 / Chains 9 + 10 — register `/sessions/{sid}/fs:*` routes.
    // POST :list / :read / :list_many / :stat / :stat_many — daemon-OWN
    // service, no agent-core bridge involved. Path safety is the central
    // correctness concern; every input path flows through
    // `resolveSafePath(cwd, input)` before any Node fs syscall.
    registerFsRoutes(
      apiV1 as unknown as Parameters<typeof registerFsRoutes>[0],
      ix,
    );

    // W12.2 / Chain 15 — register `/files*` routes (upload / download /
    // delete). Registers `@fastify/multipart` lazily on the captured
    // Fastify instance. Anti-corruption invariant: handlers resolve
    // `IFileStore` via the DI accessor; no SDK imports.
    registerFilesRoutes(
      apiV1 as unknown as Parameters<typeof registerFilesRoutes>[0],
      ix,
    );
  }, { prefix: '/api/v1' });

  // Register Swagger UI AFTER all routes are collected.
  await app.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Fastify lazily creates the raw `http.Server`. `WSGateway` (W5.1) needs
  // `app.server` to attach an `'upgrade'` listener — `app.ready()` populates
  // it without binding to a port (that happens later in `IRestGateway.listen`).
  try {
    await app.ready();
  } catch (err) {
    lockHandle.release();
    throw err;
  }

  // Touch every descriptor in CONSTRUCTION order so `_constructionOrder`
  // records them for reverse-dispose. The collection seeded above carries
  // a `SyncDescriptor` for each singleton; the first `a.get(IX)` resolves
  // it through `_createAndCacheServiceInstance`, auto-injecting any `@I*`
  // decorated ctor params. Two non-descriptor wirings remain inline below
  // (the `IEventReplayService` alias + the closure-based `IFsWatcher`);
  // both are documented near their construction sites.
  let coreProcess: ICoreProcessService;
  try {
    coreProcess = ix.invokeFunction((a) => {
      // ILogger first so it disposes LAST.
      const log = a.get(ILogger);
      a.get(IRestGateway);

      // Plan §4.5: wire `setUnexpectedErrorHandler` HERE — AFTER the
      // container has resolved `ILogger`, NOT at module load time. Doing it
      // at module load risks a startup-time listener exception NPE'ing on
      // an unresolved logger (the handler closure would capture an
      // undefined `log`). Routing unexpected errors to the daemon logger
      // means Emitter listener exceptions (which `Emitter.fire()` forwards
      // to `onUnexpectedError`) surface as structured `[unexpected]` log
      // lines instead of being silently dropped.
      //
      // Argument order matches the daemon's `ILogger.error(obj, msg)`
      // signature (= pino's `error({...}, '[unexpected]')` form) — the
      // structured payload comes FIRST so pino attaches it to the line, and
      // the `[unexpected]` tag is the human-readable message.
      setUnexpectedErrorHandler((err) => {
        log.error(
          err instanceof Error ? { msg: err.message, stack: err.stack } : { err },
          '[unexpected]',
        );
      });

      // W5.1 / P2.1: IConnectionRegistry BEFORE event bus / brokers so the
      // reverse-dispose chain tears down WS connections (via IWSGateway, which
      // is constructed LATE → disposes EARLY) before brokers can emit on them.
      a.get(IConnectionRegistry);

      // W5.2 / P2.2: ISessionClientsService BEFORE IEventService so the bus
      // can hold a reference to it for broadcast fan-out. SessionClients
      // disposes AFTER IEventService (reverse-order) — by then the bus has
      // already stopped publishing, so dropping the subscriber index is safe.
      a.get(ISessionClientsService);

      // EventService — touching constructs it via the descriptor (auto-injects
      // @ILogger + @ISessionClientsService). Cast to the concrete class so we
      // can call `.currentSeq(...)` on it from the WS abort handler below
      // (only the concrete class exposes that helper).
      const eventBus = a.get(IEventService) as EventService;
      // Alias the SAME singleton under the daemon-local `IEventReplayService`
      // contract (split from `IEventService` in Phase 2). `WSGateway` and
      // (later) `WsConnection` use this typed accessor instead of importing
      // the concrete `EventService` class. No new instance is constructed;
      // the alias is recorded BEFORE WSGateway is built so its
      // `@IEventReplayService` ctor decoration resolves to the live bus.
      //
      // This is one of two non-descriptor `services.set()` calls retained
      // post-Phase-4: an ALIAS, not a fresh registration. The collection
      // helper intentionally skips it (see `serviceCollection.ts` header).
      services.set(IEventReplayService, eventBus);
      a.get(IEventReplayService);

      // Touch the brokers in order so they're recorded for reverse teardown
      // (Question → Approval → EventBus dispose direction).
      a.get(IApprovalService);
      a.get(IQuestionService);

      // W5.1 / P2.3: WSGateway constructed AFTER brokers but BEFORE CoreProcessService.
      // Reverse-dispose order then runs: CoreProcessService → WSGateway (closes WS
      // conns via registry) → brokers → SessionClients → registry → RestGateway
      // → Logger. That's safe because brokers no longer have active sockets
      // to emit to.
      const wsGw = a.get(IWSGateway);

      // P2.5: CoreProcessService is now a descriptor with `coreProcessOptions`
      // baked into the `staticArguments` of the `SyncDescriptor`. Touching
      // the decorator constructs the singleton with the production options.
      const built = a.get(ICoreProcessService);

      // Construction order: [..., ICoreProcessService, ISessionService, ...]
      a.get(ISessionService);
      a.get(IMessageService);

      // P2.1 / Chain P2.1.2 — IAuthSummaryService. Powers `GET /v1/auth` +
      // the `ensureReady` gate consumed by IPromptService.
      a.get(IAuthSummaryService);

      // P2.7 — IOAuthService.
      a.get(IOAuthService);

      // W7.2 / Chain 4 — IPromptService. Phase C: PromptService
      // self-subscribes to the bus via @IEventService.onDidPublish.
      const promptService = a.get(IPromptService);

      // W7.3 — wire the WS abort handler. Both REST and WS abort go through
      // `IPromptService.abort`; the WS connection needs an `AbortHandler`
      // adapter exposing `abort()` + `currentSeq()` so it can populate the
      // ack `at_seq` on idempotent calls. We compose one in-place.
      wsGw.setAbortHandler({
        abort: (sid, pid) => promptService.abort(sid, pid),
        currentSeq: (sid) => eventBus.currentSeq(sid),
      });

      // W9.1 / Chain 7 — IToolService + IMcpService.
      a.get(IToolService);
      a.get(IMcpService);

      // W9.2 / Chain 8 — ITaskService.
      a.get(ITaskService);

      // W10 / Chains 9 + 10 — IFsService (DAEMON-OWN).
      a.get(IFsService);

      // W11 / Chain 11 — IFsSearchService (DAEMON-OWN).
      a.get(IFsSearchService);

      // W11 / Chain 12 — IFsGitService (DAEMON-OWN).
      a.get(IFsGitService);

      // W12 / Chain 14 — IFsWatcher. DAEMON-OWN. Wraps a per-session
      // chokidar `FSWatcher`, coalesces events over 200ms windows,
      // truncates at 500 raw events/window, and pushes targeted (NOT
      // broadcast) `event.fs.changed` frames to the connections whose
      // subscribed paths overlap the change.
      //
      // **Closure-exception wiring** (Phase 4 §2.2): the watcher needs a
      // `connection-lookup` closure built from `IConnectionRegistry.get`.
      // That closure isn't serializable into a `SyncDescriptor` static-arg,
      // so we build it inline here and register the resulting instance.
      // This is the documented descriptor-first exception per
      // `serviceCollection.ts` header.
      //
      // P2.6: @ILogger + @ISessionService auto-injected; only `lookup`
      // (closure over the live registry) and `{}` options remain as
      // positional static args.
      const registry = a.get(IConnectionRegistry);
      const fsWatcher = ix.createInstance(
        FsWatcherService,
        createConnectionLookup((id) => registry.get(id)),
        {},
      );
      services.set(IFsWatcher, fsWatcher);
      a.get(IFsWatcher);

      // Build the WS adapter mapping `(sessionId, connId, wirePaths) →
      // resolve cwd → resolveSafePath → IFsWatcher.addPaths/removePaths`.
      // Errors map to wire ack codes:
      //   - FsWatchLimitError  → 42902 fs.watch_limit_exceeded
      //   - FsPathEscapesError → 41304 fs.path_escapes_session
      //   - SessionNotFoundError → 40401 session.not_found
      //   - other              → 50001 internal
      const fsWatchHandler = {
        async add(sessionId: string, connectionId: string, wirePaths: readonly string[]) {
          try {
            const session = await a.get(ISessionService).get(sessionId);
            // `resolveSafePath` realpath's the cwd internally; we must use
            // the SAME realpath here for the absolute→POSIX-relative
            // conversion (macOS routes `/tmp` to `/private/tmp`, etc).
            const realCwd = await fspPromises.realpath(session.metadata.cwd);
            // Bind cwd so the watcher can map absolute → POSIX-relative on emit.
            fsWatcher.bindSessionCwd(sessionId, realCwd);
            const absPaths: string[] = [];
            for (const p of wirePaths) {
              const safe = await resolveSafePath(session.metadata.cwd, p);
              absPaths.push(safe.absolute);
            }
            fsWatcher.addPaths(sessionId, connectionId, absPaths);
            const watched = fsWatcher.watchedPaths(connectionId, sessionId);
            // Convert absolute paths back to POSIX-relative for the wire.
            const wire = watched.map((abs) => toPosixRelativeForCwd(realCwd, abs));
            return {
              ok: true as const,
              watched_paths: wire,
              current_count: fsWatcher.countForConnection(connectionId),
            };
          } catch (err) {
            return mapFsWatchError(err);
          }
        },
        async remove(sessionId: string, connectionId: string, wirePaths: readonly string[]) {
          try {
            const session = await a.get(ISessionService).get(sessionId);
            const realCwd = await fspPromises.realpath(session.metadata.cwd);
            const absPaths: string[] = [];
            for (const p of wirePaths) {
              // Path safety still applies — clients can't unwatch a path that
              // escapes cwd (defensive; we'd reject the corresponding add too).
              const safe = await resolveSafePath(session.metadata.cwd, p);
              absPaths.push(safe.absolute);
            }
            fsWatcher.removePaths(sessionId, connectionId, absPaths);
            const watched = fsWatcher.watchedPaths(connectionId, sessionId);
            const wire = watched.map((abs) => toPosixRelativeForCwd(realCwd, abs));
            return {
              ok: true as const,
              watched_paths: wire,
              current_count: fsWatcher.countForConnection(connectionId),
            };
          } catch (err) {
            return mapFsWatchError(err);
          }
        },
        cleanupConnection(connectionId: string) {
          fsWatcher.forgetConnection(connectionId);
        },
      };
      wsGw.setFsWatchHandler(fsWatchHandler);

      // W12.2 / Chain 15 — IFileStore. DAEMON-OWN. Persists uploads under
      // `<homeDir>/files/` with a JSON index. The `homeDir` override is
      // baked into the `SyncDescriptor`'s static args by
      // `createDaemonServiceCollection()`.
      a.get(IFileStore);

      return built;
    });
  } catch (err) {
    // Container half-built — dispose what we have, drop the lock, rethrow.
    try {
      ix.dispose();
    } catch {
      /* ignore */
    }
    lockHandle.release();
    throw err;
  }

  // CoreProcessService readiness gate — KimiCore plugin init + RPC binding
  // completion. Awaiting before listen() means /healthz only goes live once
  // the services graph is fully usable.
  try {
    await coreProcess.ready();
  } catch (err) {
    try {
      ix.dispose();
    } catch {
      /* ignore */
    }
    lockHandle.release();
    throw err;
  }
  pinoLogger.info('core process ready');

  let address: string;
  try {
    address = await ix.invokeFunction((a) => a.get(IRestGateway).listen(opts.host, opts.port));
  } catch (err) {
    try {
      ix.dispose();
    } catch {
      /* ignore */
    }
    lockHandle.release();
    throw err;
  }
  pinoLogger.info({ address, lockPath: lockHandle.lockPath }, 'daemon listening');

  let closed = false;
  return {
    address,
    logger: pinoLogger,
    services: ix,
    close: async () => {
      if (closed) return;
      closed = true;
      // 1. Close attached WS connections FIRST (with WS code 1001 = going
      //    away). If we let `app.close()` run first it would tear down the
      //    underlying TCP sockets, denying us a clean WS close frame.
      //    The container's reverse-dispose chain runs the same logic via
      //    `WSGateway.dispose()`, but Fastify's `close()` is async and races
      //    its socket-killer against our timing — so we explicitly drain the
      //    WS gateway here first.
      try {
        ix.invokeFunction((a) => a.get(IWSGateway));
        // WSGateway has no public drain method (closes happen on dispose);
        // we trigger it via the registry directly, which is idempotent.
        ix.invokeFunction((a) => a.get(IConnectionRegistry).closeAll('daemon shutting down'));
      } catch {
        // container may be partially disposed — fall through to app.close()
      }
      // 2. Stop accepting new requests + drain in-flight ones. Done
      //    explicitly here (instead of relying on FastifyRestGateway.dispose's
      //    fire-and-forget) so callers see a real `await` boundary.
      try {
        await app.close();
      } catch {
        // continue teardown even if drain throws
      }
      // 3. Dispose container: CoreProcessService → WSGateway → brokers → registry
      //    → gateway → logger (reverse construction order). WSGateway.dispose()
      //    now finds an empty registry; harmless idempotent path.
      try {
        ix.dispose();
      } catch {
        // continue
      }
      // 3. Release the lock LAST so other tooling can rely on lock-absence ==
      //    daemon-fully-shut-down.
      lockHandle.release();
    },
  };
}

/* -------------------------------------------------------------------------
 * Helpers for the FsWatchHandler adapter (W12 / Chain 14)
 * ----------------------------------------------------------------------- */

/**
 * Wire-path conversion for the `watched_paths` ack field. Same algorithm
 * as `fs-path-safety.ts:toPosixRelative` but inlined here so the start.ts
 * adapter doesn't import path-safety internals (the safety module's
 * `toPosixRelative` is private). If a future iteration needs the helper
 * in more places we can hoist it.
 */
function toPosixRelativeForCwd(cwd: string, abs: string): string {
  if (abs === cwd) return '.';
  const rel = nodePathRelativeNative(cwd, abs);
  if (rel === '') return '.';
  return rel.split(nodePathSep).join('/');
}

/**
 * Translate watcher-layer errors into the wire `code` the WS ack carries.
 */
function mapFsWatchError(err: unknown):
  | { ok: false; code: number; msg: string } {
  if (err instanceof FsWatchLimitError) {
    return {
      ok: false,
      code: ErrorCode.FS_WATCH_LIMIT_EXCEEDED,
      msg: err.message,
    };
  }
  if (err instanceof FsPathEscapesError) {
    return {
      ok: false,
      code: ErrorCode.FS_PATH_ESCAPES_SESSION,
      msg: err.message,
    };
  }
  if (err instanceof SessionNotFoundError) {
    return {
      ok: false,
      code: ErrorCode.SESSION_NOT_FOUND,
      msg: 'session not found',
    };
  }
  return {
    ok: false,
    code: ErrorCode.INTERNAL_ERROR,
    msg: err instanceof Error ? err.message : 'fs watch error',
  };
}
