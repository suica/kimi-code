export { startDaemon, DaemonLockedError } from './start.js';
export type { DaemonStartOptions, RunningDaemon } from './start.js';
export { okEnvelope, errEnvelope } from './envelope.js';
export type { Envelope } from './envelope.js';
export { createDaemonLogger } from './logger.js';
export type { CreateLoggerOptions, DaemonLogger, DaemonLogLevel } from './logger.js';
export { acquireLock, DEFAULT_LOCK_PATH, DEFAULT_LOCK_DIR } from './lock.js';
export type { AcquireLockOptions, AcquireLockResult, LockContents } from './lock.js';

// DI service decorators — re-exported so consumers / tests can `a.get(ILogService)` etc.
// The concrete impls (PinoLogger, FastifyRestGateway, WSBroadcastService,
// ApprovalService / QuestionService, ConnectionRegistry, SessionClientsService,
// WSGateway) stay internal — daemon owns its wiring choices; external consumers
// see only the interfaces.
export { ILogService } from '#/services/logger';
export { IRestGateway } from '#/services/gateway';
export { IConnectionRegistry } from '#/services/gateway';
export { ISessionClientsService } from '#/services/gateway';
export { IWSGateway } from '#/services/gateway';
export { IWSBroadcastService } from '#/services/gateway';
// Re-export service decorators from `@moonshot-ai/services` so daemon
// consumers don't have to take a direct dep on the services package just to
// reach into the container.
export {
  IEventService,
  IApprovalService,
  IQuestionService,
  ICoreProcessService,
  ISessionService,
  SessionNotFoundError,
} from '@moonshot-ai/services';
