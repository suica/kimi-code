/**
 * `@moonshot-ai/services` — in-process service container for the kimi-code
 * daemon. Houses broker interfaces (reverse-RPC: KimiCore → daemon) and the
 * `HarnessBridge` that owns the in-process `KimiCore` instance.
 *
 * Per-domain layout (Phase B):
 *   session/session-service.ts       — ISessionService + SessionService + toProtocolSession
 *   message/message-service.ts       — IMessageService + MessageService + toProtocolMessage
 *   prompt/prompt-service.ts         — IPromptService + PromptService + IPromptLifecycleObserver
 *   tool/tool-service.ts             — IToolService + ToolService + toProtocolTool
 *   mcp/mcp-service.ts               — IMcpService + McpService + toProtocolMcpServer
 *   task/task-service.ts             — ITaskService + TaskService + toProtocolTask
 *   oauth/oauth-service.ts           — IOAuthService + OAuthService
 *   auth-summary/auth-summary-service.ts — IAuthSummaryService + AuthSummaryService
 *   event/event-bus.ts               — IEventBus
 *   approval/approval-broker.ts      — IApprovalBroker + adapter helpers
 *   question/question-broker.ts      — IQuestionBroker + adapter helpers
 *   bridge/                          — HarnessBridge + BridgeClientAPI + lifecycle
 */

export { BridgeClientAPI } from './bridge/bridge-client-api';
export type { BridgeClientAPIDeps } from './bridge/bridge-client-api';
export {
  HarnessBridge,
  IHarnessBridge,
  type HarnessBridgeOptions,
  type HarnessRPC,
} from './bridge/harness-bridge';
export {
  defaultServicesModule,
  type ServiceModuleEntry,
} from './module';

// --- per-domain exports ---------------------------------------------------

// event bus
export { IEventBus } from './event/event-bus';

// approval broker + adapter
export { IApprovalBroker } from './approval/approval-broker';
export type { ApprovalRequest, ApprovalResponse } from './approval/approval-broker';
export {
  toAgentCoreResponse as approvalToAgentCoreResponse,
  toBrokerRequest as approvalToBrokerRequest,
  type ToBrokerRequestParams as ApprovalToBrokerRequestParams,
} from './approval/approval-broker';

// question broker + adapter
export { IQuestionBroker } from './question/question-broker';
export type { QuestionRequest, QuestionResult } from './question/question-broker';
export {
  toAgentCoreResponse as questionToAgentCoreResponse,
  toBrokerRequest as questionToBrokerRequest,
  dismissedResult as questionDismissedResult,
  type QuestionToBrokerRequestParams,
} from './question/question-broker';

// auth-summary service
export {
  IAuthSummaryService,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  AuthTokenUnauthorizedError,
  AuthModelNotResolvedError,
  AuthSummaryService,
  type AuthSummaryServiceOptions,
} from './auth-summary/auth-summary-service';

// oauth service
export {
  IOAuthService,
  OAuthService,
  type OAuthServiceOptions,
} from './oauth/oauth-service';

// session service + adapter
export {
  ISessionService,
  SessionNotFoundError,
  SessionService,
  toProtocolSession,
} from './session/session-service';
export type { SessionListQuery } from './session/session-service';

// message service + adapter
export {
  IMessageService,
  MessageNotFoundError,
  MessageService,
  deriveMessageId,
  parseMessageId,
  toProtocolMessage,
} from './message/message-service';
export type { MessageListQuery } from './message/message-service';

// prompt service
export {
  IPromptService,
  PromptAlreadyCompletedError,
  PromptNotFoundError,
  SessionBusyError,
  PromptService,
} from './prompt/prompt-service';
export type {
  IPromptLifecycleObserver,
  PromptAbortResult,
  SyntheticPromptAbortedEvent,
  SyntheticPromptCompletedEvent,
} from './prompt/prompt-service';

// tool service + adapter
export {
  IToolService,
  ToolService,
  toProtocolTool,
  type AgentCoreToolInfoLike,
} from './tool/tool-service';

// mcp service + adapter
export {
  IMcpService,
  McpServerNotFoundError,
  McpService,
  toProtocolMcpServer,
} from './mcp/mcp-service';

// task service + adapter
export {
  ITaskService,
  TaskAlreadyFinishedError,
  TaskNotFoundError,
  TaskService,
  toProtocolTask,
  isTerminalStatus,
} from './task/task-service';
export type { TaskListQuery } from './task/task-service';

// NOTE: `registerHarnessBridge` (./bridge/lifecycle.ts) is intentionally not
// re-exported. `defaultServicesModule()` is the canonical wiring path; the
// registry-style helper exists only for legacy side-effect-on-import contexts.
