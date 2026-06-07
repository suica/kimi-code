/**
 * `@moonshot-ai/services` — in-process service container for the kimi-code
 * daemon. Houses broker interfaces (reverse-RPC: KimiCore → daemon) and the
 * `HarnessBridge` that owns the in-process `KimiCore` instance.
 *
 * Per-domain layout (Phase B):
 *   session/session.ts              — ISessionService + toProtocolSession
 *   session/sessionService.ts       — SessionService
 *   message/message.ts              — IMessageService + toProtocolMessage
 *   message/messageService.ts       — MessageService
 *   prompt/prompt.ts                — IPromptService + SyntheticPrompt* events
 *   prompt/promptService.ts         — PromptService
 *   tool/tool.ts                    — IToolService + toProtocolTool
 *   tool/toolService.ts             — ToolService
 *   mcp/mcp.ts                      — IMcpService + toProtocolMcpServer
 *   mcp/mcpService.ts               — McpService
 *   task/task.ts                    — ITaskService + toProtocolTask
 *   task/taskService.ts             — TaskService
 *   oauth/oauth.ts                  — IOAuthService
 *   oauth/oauthService.ts           — OAuthService
 *   auth-summary/auth-summary.ts    — IAuthSummaryService
 *   auth-summary/authSummaryService.ts — AuthSummaryService
 *   event/event-bus.ts              — IEventBus
 *   approval/approval-broker.ts     — IApprovalBroker + adapter helpers
 *   question/question-broker.ts     — IQuestionBroker + adapter helpers
 *   bridge/                         — HarnessBridge + BridgeClientAPI + lifecycle
 */

export { BridgeClientAPI } from './bridge/bridge-client-api';
export type { BridgeClientAPIDeps } from './bridge/bridge-client-api';
export {
  IHarnessBridge,
  type HarnessBridgeOptions,
  type HarnessRPC,
} from './bridge/harness-bridge';
export { HarnessBridge } from './bridge/harnessBridge';
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
  type AuthSummaryServiceOptions,
} from './auth-summary/auth-summary';
export { AuthSummaryService } from './auth-summary/authSummaryService';

// oauth service
export {
  IOAuthService,
  type OAuthServiceOptions,
} from './oauth/oauth';
export { OAuthService } from './oauth/oauthService';

// session service + adapter
export {
  ISessionService,
  SessionNotFoundError,
  toProtocolSession,
} from './session/session';
export type { SessionListQuery } from './session/session';
export { SessionService } from './session/sessionService';

// message service + adapter
export {
  IMessageService,
  MessageNotFoundError,
  deriveMessageId,
  parseMessageId,
  toProtocolMessage,
} from './message/message';
export type { MessageListQuery } from './message/message';
export { MessageService } from './message/messageService';

// prompt service
export {
  IPromptService,
  PromptAlreadyCompletedError,
  PromptNotFoundError,
  SessionBusyError,
} from './prompt/prompt';
export type {
  PromptAbortResult,
  SyntheticPromptAbortedEvent,
  SyntheticPromptCompletedEvent,
} from './prompt/prompt';
export { PromptService } from './prompt/promptService';

// tool service + adapter
export {
  IToolService,
  toProtocolTool,
  type AgentCoreToolInfoLike,
} from './tool/tool';
export { ToolService } from './tool/toolService';

// mcp service + adapter
export {
  IMcpService,
  McpServerNotFoundError,
  toProtocolMcpServer,
} from './mcp/mcp';
export { McpService } from './mcp/mcpService';

// task service + adapter
export {
  ITaskService,
  TaskAlreadyFinishedError,
  TaskNotFoundError,
  toProtocolTask,
  isTerminalStatus,
} from './task/task';
export type { TaskListQuery } from './task/task';
export { TaskService } from './task/taskService';

// NOTE: `registerHarnessBridge` (./bridge/lifecycle.ts) is intentionally not
// re-exported. `defaultServicesModule()` is the canonical wiring path; the
// registry-style helper exists only for legacy side-effect-on-import contexts.
