/**
 * `defaultServicesModule()` — DI entries shipped by `@moonshot-ai/services`.
 * Includes the `CoreProcessService` plus every positive `IXxxService` for
 * which the impl ships in this package.
 *
 * Callers spread the array into a `ServiceCollection` ctor:
 *
 *   const entries = defaultServicesModule();
 *   const collection = new ServiceCollection(
 *     ...entries.map(([id, descriptor]) => [id, descriptor] as const),
 *     // ...peer-service impls (IEventService / IApprovalService /
 *     //    IQuestionService — those live in @moonshot-ai/daemon)
 *   );
 *
 * Each entry is `[ServiceIdentifier, SyncDescriptor, InstantiationType]` —
 * the `InstantiationType` is informational today (W2 treats Delayed as Eager;
 * see instantiationService.ts:158 TODO). When delayed-instantiation lands the
 * wiring layer can route entries accordingly without touching this module.
 *
 * Canonical wiring strategy: `defaultServicesModule()` returned to the
 * daemon's bootstrap, which builds the `ServiceCollection` once. We do NOT
 * use the global `registerSingleton` registry as the canonical path — the
 * registry exists for legacy "side-effect on import" wiring and is exposed
 * only via `./coreProcess/lifecycle.ts`'s `registerCoreProcessService` helper
 * (NOT re-exported from the package barrel).
 *
 * Per-domain layout: see `packages/services/AGENTS.md`. Classes live in
 * per-domain folders (`session/`, `message/`, …) with one `<domain>.ts`
 * contracts file and one `<domain>Service.ts` impl file each.
 */

import {
  InstantiationType,
  SyncDescriptor,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core';

import { CoreProcessService } from './coreProcess/coreProcessService';
import { ICoreProcessService } from './coreProcess/coreProcess';
import { McpService } from './mcp/mcpService';
import { IMcpService } from './mcp/mcp';
import { MessageService } from './message/messageService';
import { IMessageService } from './message/message';
import { PromptService } from './prompt/promptService';
import { IPromptService } from './prompt/prompt';
import { SessionService } from './session/sessionService';
import { ISessionService } from './session/session';
import { TaskService } from './task/taskService';
import { ITaskService } from './task/task';
import { ToolService } from './tool/toolService';
import { IToolService } from './tool/tool';

export type ServiceModuleEntry = readonly [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ServiceIdentifier<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SyncDescriptor<any>,
  InstantiationType,
];

export function defaultServicesModule(): ReadonlyArray<ServiceModuleEntry> {
  return [
    [ICoreProcessService, new SyncDescriptor(CoreProcessService), InstantiationType.Eager],
    // Chain 2 — `ISessionService`. @ICoreProcessService auto-injects; the
    // daemon's `start.ts` calls `ix.createInstance(SessionService)` then
    // `services.set(ISessionService, instance)`. The descriptor entry
    // documents that ISessionService is part of the canonical service set.
    [ISessionService, new SyncDescriptor(SessionService), InstantiationType.Eager],
    // Chain 3 — `IMessageService`. Same auto-inject wiring as ISessionService;
    // @ICoreProcessService is resolved by the container.
    [IMessageService, new SyncDescriptor(MessageService), InstantiationType.Eager],
    // Chain 4 — `IPromptService`. Ctor takes @ICoreProcessService +
    // @IEventService (it self-registers as a lifecycle observer on the event
    // stream so it can synthesize `prompt.completed` / `prompt.aborted` from
    // `turn.ended`). Both deps auto-inject; daemon calls
    // `ix.createInstance(PromptService)`.
    [IPromptService, new SyncDescriptor(PromptService), InstantiationType.Eager],
    // Chain 7 — `IToolService` + `IMcpService`. Both depend only on
    // @ICoreProcessService; daemon's `start.ts` wires them after
    // `IPromptService` so reverse-dispose closes them before the core process
    // adapter.
    [IToolService, new SyncDescriptor(ToolService), InstantiationType.Eager],
    [IMcpService, new SyncDescriptor(McpService), InstantiationType.Eager],
    // Chain 8 — `ITaskService`. Same auto-inject wiring as IToolService /
    // IMcpService; appended last so reverse-dispose closes it first among
    // the new services.
    [ITaskService, new SyncDescriptor(TaskService), InstantiationType.Eager],
  ] as const;
}
